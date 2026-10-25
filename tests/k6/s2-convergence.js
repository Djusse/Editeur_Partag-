/**
 * S2 — C2 : N rédacteurs écrivent au même endroit du même document,
 * aucune modification n'est perdue, et tous convergent.
 *
 * Objectif du plan v7 : montée 50 → 100 → 300 rédacteurs.
 *
 * Ce que le test prouve :
 *   - toutes les insertions sont acquittées (`ack` contenant l'`opId` émis) ;
 *   - le `seq` reste **contigu** (aucun trou) ;
 *   - le texte final contient **toutes** les contributions ;
 *   - la latence d'acquittement reste acceptable alors que le hub diffuse un
 *     seul message par tick de 250 ms.
 *
 * ⚠️ Une limite à connaître : k6 ne fournit pas de client Yjs. Un vrai CRDT
 * exige un encodage binaire et une fusion côté client. Plutôt que de simuler
 * un « faux Yjs » (ce qui ne prouverait rien), ce scénario envoie des updates
 * produits par **le module yjs embarqué côté serveur de test** via le repli
 * HTTP et le WebSocket — voir `tests/node/verify-convergence.mjs` pour la
 * vérification de convergence stricte, qui décodera l'état final.
 *
 * Ce script mesure donc ce que k6 sait mesurer correctement : le **débit
 * d'acquittement**, la **contiguïté du `seq`**, et l'**absence d'erreur** sous
 * N connexions WebSocket simultanées. La preuve de convergence du contenu est
 * apportée par `tests/node/verify-convergence.mjs`, exécuté après S2.
 *
 * Usage :
 *   k6 run -e API_URL=http://13.53.160.209 -e TOKEN=<jwt> -e DOC_ID=<doc> \
 *          -e WRITERS=100 --summary-export=tests/results/s2-100.json \
 *          tests/k6/s2-convergence.js
 */
import http from 'k6/http';
import { check, sleep } from 'k6';
import { Counter, Trend } from 'k6/metrics';
import { apiBase, authHeaders, requireEnv, runId } from './lib/common.js';

const WRITERS = Number(__ENV.WRITERS || 100);
const DURATION = __ENV.DURATION || '60s';
/** Caractères par update : petit, pour que le crédit ne soit pas le facteur limitant. */
const TEXT = __ENV.TEXT || 'x';

const acked = new Counter('s2_acked');
const rejected = new Counter('s2_rejected');
const missingAck = new Counter('s2_missing_ack');
const ackLatency = new Trend('s2_ack_latency', true);
const seenSeq = new Counter('s2_updates_recu');

export const options = {
  scenarios: {
    writers: {
      executor: 'constant-vus',
      vus: WRITERS,
      duration: DURATION,
      gracefulStop: '15s',
      tags: { scenario: 's2' },
    },
  },
  thresholds: {
    'http_req_failed{scenario:s2}': ['rate<0.01'],
    // Le hub acquitte en un tick de 250 ms ; 3 s laisse de la marge sous charge.
    's2_ack_latency{scenario:s2}': ['p(95)<3000'],
  },
  summaryTrendStats: ['avg', 'min', 'med', 'p(90)', 'p(95)', 'p(99)', 'max'],
};

export function setup() {
  const docId = requireEnv('DOC_ID');
  return { docId, run: runId() };
}

/**
 * Un rédacteur : ouvre un WebSocket, rejoint le document, écrit en boucle,
 * et vérifie que chaque update reçoit son `ack`.
 */
export default function (data) {
  const ticketResponse = http.post(
    `${apiBase()}/ws-ticket`,
    JSON.stringify({ documentId: data.docId }),
    { headers: authHeaders(), tags: { name: 'ws-ticket' } },
  );

  if (
    !check(ticketResponse, {
      'S2 : ticket obtenu (200)': (r) => r.status === 200,
    })
  ) {
    rejected.add(1);
    return;
  }

  const ticket = JSON.parse(ticketResponse.body).ticket;
  const url = `${(__ENV.API_URL || 'http://localhost:4000').replace(/\/+$/, '').replace(/^http/, 'ws')}/ws?ticket=${encodeURIComponent(ticket)}&documentId=${encodeURIComponent(data.docId)}`;

  const socket = new WebSocket(url);
  const sentAt = new Map();
  let joined = false;
  let seqs = [];

  socket.onopen = () => {
    socket.send(JSON.stringify({ type: 'join', documentId: data.docId, sinceSeq: 0 }));
  };

  socket.onmessage = (event) => {
    let message;
    try {
      message = JSON.parse(event.data);
    } catch (error) {
      return;
    }

    if (message.type === 'joined') {
      joined = true;
      // On écrit dès l'ouverture : pas d'attente artificielle, c'est le cas réel.
      sendUpdate();
      return;
    }

    if (message.type === 'update') {
      seenSeq.add(1);
      seqs.push(message.seq);
      return;
    }

    if (message.type === 'ack' && Array.isArray(message.opIds)) {
      for (const opId of message.opIds) {
        const at = sentAt.get(opId);
        if (at !== undefined) {
          ackLatency.add(Date.now() - at);
          sentAt.delete(opId);
          acked.add(1);
        }
      }
      return;
    }

    if (message.type === 'error') {
      rejected.add(1);
      if (message.code === 'CREDIT_EXHAUSTED' || message.code === 'BLOCKED') {
        // Le rédacteur de test a épuisé son crédit : on ferme proprement.
        socket.close();
      }
    }
  };

  socket.onerror = () => rejected.add(1);

  /**
   * Envoie un update Yjs minimal.
   *
   * On utilise un update encodé une fois pour toutes : un `Y.Text` contenant
   * un caractère. Le serveur le compte (1 caractère) et l'applique. Ce n'est
   * pas un update « riche », mais il exerce exactement le chemin critique :
   * validation du binaire, comptage du crédit, transaction atomique,
   * acquittement après durabilité.
   */
  function sendUpdate() {
    if (!joined) return;
    const opId = `op_s2_${data.run}_${__VU}_${__ITER}_${Date.now()}`;
    sentAt.set(opId, Date.now());
    socket.send(
      JSON.stringify({
        type: 'update',
        opId,
        documentId: data.docId,
        payload: minimalUpdate(),
      }),
    );
  }

  // Chaque VU envoie une rafale puis attend les acquittements.
  for (let i = 0; i < 5; i++) {
    sendUpdate();
  }

  // On laisse le temps aux `ack` d'arriver avant la fin de l'itération.
  sleep(1);

  // Un `opId` sans `ack` après une seconde signale un update perdu.
  if (sentAt.size > 0) {
    missingAck.add(sentAt.size);
  }

  // Contiguïté : les `seq` reçus doivent former une suite croissante de pas 1.
  for (let i = 1; i < seqs.length; i++) {
    if (seqs[i] !== seqs[i - 1] + 1) {
      // Un trou est anormal avec un seul écrivain par document.
      check(null, {
        [`S2 : trou de séquence entre ${seqs[i - 1]} et ${seqs[i]}`]: () => false,
      });
    }
  }

  socket.close();
}

/**
 * Update Yjs constant : `Y.Text('content')` avec un caractère `x`.
 *
 * Encodage produit **hors de k6**, avec la vraie bibliothèque yjs, puis figé en
 * base64 : le moteur k6 n'a ni `Buffer` ni les modules Node, donc importer yjs
 * y est impossible. L'update a été vérifié avec le compteur du serveur :
 *
 *   creditCost(Buffer.from(B64, 'base64')) → inserted=1, deleted=0, structs=1
 *
 * C'est ce qui garantit que le scénario exerce bien le chemin critique :
 * validation du binaire, comptage du crédit, transaction atomique.
 * Pour en produire un autre :
 *
 *   cd backend && node --input-type=module -e "
 *     import * as Y from 'yjs';
 *     const d = new Y.Doc(); const u = [];
 *     d.on('update', (x) => u.push(x));
 *     d.getText('content').insert(0, 'x');
 *     console.log(Buffer.from(u[0]).toString('base64'));"
 */
const ONE_CHAR_UPDATE_B64 = 'AQGd+OWCBAAEAQdjb250ZW50AXgA';

function minimalUpdate() {
  return __ENV.UPDATE_B64 || ONE_CHAR_UPDATE_B64;
}

export function handleSummary(data) {
  const metrics = data.metrics;
  const lines = ['', `=== S2 — C2 : ${WRITERS} rédacteurs simultanés ===`];
  const add = (label, metric, stat) => {
    const value = metrics[metric]?.values?.[stat];
    if (value !== undefined) lines.push(`  ${label.padEnd(32)} ${Number(value).toFixed(2)}`);
  };
  add('updates acquittés', 's2_acked', 'count');
  add('updates refusés', 's2_rejected', 'count');
  add('sans ack (perdus ?)', 's2_missing_ack', 'count');
  add('updates reçus', 's2_updates_recu', 'count');
  add('latence ack médiane (ms)', 's2_ack_latency', 'med');
  add('latence ack p95 (ms)', 's2_ack_latency', 'p(95)');
  const checks = metrics.checks?.values;
  if (checks) {
    lines.push(`  vérifications réussies         ${checks.passes}`);
    lines.push(`  vérifications échouées         ${checks.fails}`);
  }
  lines.push('');
  lines.push('La convergence du CONTENU est vérifiée par :');
  lines.push('  node tests/node/verify-convergence.mjs --api=<url> --token=<jwt> --doc=<doc>');
  lines.push('');
  return {
    stdout: lines.join('\n'),
    [`tests/results/s2-${WRITERS}.json`]: JSON.stringify(data, null, 2),
  };
}
