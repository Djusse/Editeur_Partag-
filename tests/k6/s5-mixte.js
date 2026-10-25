/**
 * S5 — C5 : le pic complet, visiteurs **et** rédacteurs en même temps.
 *
 * Objectif du plan v7 : S1 (15 000 clics, 80 % en 60 s) **plus** 300 rédacteurs
 * dans le même document, simultanément.
 *
 * Ce que le test doit prouver :
 *   - les visiteurs obtiennent toujours un état explicite (`ready` / `waiting` /
 *     `exhausted`), jamais une erreur 5xx ;
 *   - les rédacteurs ne sont **pas perturbés** : leurs updates restent acquittés ;
 *   - le micro-cache de `/status` absorbe le pic (nginx, pas Node) ;
 *   - l'instance tient : CPU et mémoire restent dans les limites.
 *
 * Les métriques système (CPU, mémoire) ne sont **pas** visibles depuis k6 : il
 * faut les relever en parallèle sur CloudWatch. La commande est fournie en
 * résumé de fin de script.
 *
 * Prérequis :
 *   - `TOKEN`   : jeton du rédacteur propriétaire d'un lien (scénario visiteur) ;
 *   - `DOC_ID`  : document où écrivent les rédacteurs (peut être le même) ;
 *   - `TOKEN2`  : jeton d'un **autre** compte pour les rédacteurs si le crédit
 *                 du premier doit rester disponible pour la préparation.
 *
 * Usage :
 *   k6 run -e API_URL=http://13.53.160.209 -e TOKEN=<jwt> -e DOC_ID=<doc> \
 *          -e MAX_DOWNLOADS=500 -e VISITORS=15000 -e WRITERS=300 \
 *          tests/k6/s5-mixte.js
 */
import http from 'k6/http';
import { check, sleep } from 'k6';
import { Counter, Trend } from 'k6/metrics';
import {
  apiBase,
  claim,
  createLink,
  linkStatus,
  requireEnv,
  runId,
  visitorId,
} from './lib/common.js';
import { runWriterSession, wsBase } from './lib/ws.js';

const VISITORS = Number(__ENV.VISITORS || 15000);
const MAX_DOWNLOADS = Number(__ENV.MAX_DOWNLOADS || 500);
const WRITERS = Number(__ENV.WRITERS || 300);
const WRITER_DURATION = __ENV.WRITER_DURATION || '120s';

/**
 * Compression des paliers, pour les essais à blanc.
 *
 * Le déroulé complet dure ~2 minutes (30 + 10 + 60 + 15 s). C'est acceptable
 * pour la mesure réelle, beaucoup trop pour vérifier qu'un script démarre : on
 * perd deux minutes par essai, ce qui pousse à ne plus tester du tout — et
 * c'est ainsi qu'un scénario cassé part en production. `RAMP_SCALE=0.15`
 * ramène le déroulé à ~17 s sans changer la forme de la charge.
 */
const RAMP_SCALE = Number(__ENV.RAMP_SCALE || 1);
const stage = (seconds) => `${Math.max(1, Math.round(seconds * RAMP_SCALE))}s`;

const visitorReserved = new Counter('s5_visitor_reserved');
const visitorExhausted = new Counter('s5_visitor_exhausted');
const visitorErrors = new Counter('s5_visitor_errors');
const writerAcked = new Counter('s5_writer_acked');
const writerRejected = new Counter('s5_writer_rejected');
const writerMissing = new Counter('s5_writer_missing');
const writerTicketFailed = new Counter('s5_writer_ticket_failed');
const claimLatency = new Trend('s5_claim_latency', true);
const statusLatency = new Trend('s5_status_latency', true);
const ackLatency = new Trend('s5_ack_latency', true);

export const options = {
  scenarios: {
    // 1. Le pic visiteur, identique à S1.
    visitors: {
      executor: 'ramping-arrival-rate',
      startRate: 50,
      timeUnit: '1s',
      preAllocatedVUs: 500,
      maxVUs: 2000,
      stages: [
        { target: 100, duration: stage(30) }, // montée (20 %)
        { target: Math.round((VISITORS * 0.8) / 60), duration: stage(10) },
        { target: Math.round((VISITORS * 0.8) / 60), duration: stage(60) }, // pic 80 %
        { target: 0, duration: stage(15) },
      ],
      gracefulStop: '30s',
      tags: { scenario: 's5-visitors' },
      exec: 'visitorFlow',
    },

    // 2. Les rédacteurs, dans le même temps.
    writers: {
      executor: 'constant-vus',
      vus: WRITERS,
      duration: WRITER_DURATION,
      gracefulStop: '20s',
      startTime: '5s', // laisse les visiteurs démarrer
      tags: { scenario: 's5-writers' },
      exec: 'writerFlow',
    },

    // 3. Un client qui interroge `/status` en boucle : mesure l'effet du cache.
    statusPollers: {
      executor: 'constant-vus',
      vus: Number(__ENV.POLLERS || 20),
      duration: WRITER_DURATION,
      startTime: '5s',
      tags: { scenario: 's5-status' },
      exec: 'statusFlow',
    },
  },
  thresholds: {
    // ⚠️ **Pas** de seuil sur `http_req_failed{scenario:s5-visitors}`.
    //
    // Le parcours visiteur renvoie légitimement 410 quand le quota est épuisé.
    // k6 classe tout statut ≥ 400 comme requête échouée : au banc, 2 612 refus
    // « épuisé » sur 3 112 requêtes portaient le taux à 84 % et faisaient
    // échouer le scénario (`visitors ✗`) alors que **rien n'était cassé**.
    // C'est exactement le piège déjà rencontré en S1, où un seuil
    // `http_req_failed < 0.01` était inatteignable par construction.
    //
    // Le vrai critère « aucun 5xx » est porté par `s5_visitor_errors`
    // (compteur alimenté uniquement sur `status >= 500`) et par le verdict de
    // `handleSummary`. Un seuil qui ne peut pas être satisfait ne protège rien :
    // il rend seulement le résultat illisible.
    's5_visitor_errors{scenario:s5-visitors}': ['count==0'],
    'http_req_failed{scenario:s5-status}': ['rate<0.01'],
    's5_claim_latency{scenario:s5-visitors}': ['p(95)<3000'],
    // La preuve que le cache fonctionne : médiane très basse (nginx répond).
    // Les deux statistiques sont dans **le même** tableau : écrites en deux
    // entrées `'s5_status_latency{…}'`, la seconde écrasait la première (clé
    // d'objet identique en JavaScript) et la contrainte `med<50` disparaissait.
    's5_status_latency{scenario:s5-status}': ['med<50', 'p(95)<200'],
    // Les rédacteurs ne doivent pas perdre une seule modification sous le pic.
    's5_writer_missing{scenario:s5-writers}': ['count==0'],
    's5_writer_ticket_failed{scenario:s5-writers}': ['count==0'],
    's5_ack_latency{scenario:s5-writers}': ['p(95)<4000'],
  },
  summaryTrendStats: ['avg', 'min', 'med', 'p(90)', 'p(95)', 'p(99)', 'max'],
};

export function setup() {
  const docId = requireEnv('DOC_ID');
  const run = runId();

  // Un lien préexistant n'a **pas** forcément le quota `MAX_DOWNLOADS`, et
  // `/status` ne publie que `remaining` — pas la capacité. Afficher
  // « 500 réservations sur 100 » (constaté au banc) serait donc un chiffre faux.
  // On ne compare à `MAX_DOWNLOADS` que si c'est nous qui avons créé le lien.
  const reusedLink = Boolean(__ENV.LINK_TOKEN);
  const token = __ENV.LINK_TOKEN || createLink(docId, MAX_DOWNLOADS);
  if (!reusedLink) {
    check(linkStatus(token), {
      'S5 : lien actif au départ': (r) => r.status === 200 && r.body.status === 'active',
    });
  }

  // Même précaution que S2 : on part du `seq` courant pour ne pas rejouer tout
  // le journal à chacune des centaines de connexions.
  const writerToken = __ENV.TOKEN2 || __ENV.TOKEN;
  const stateResponse = http.get(`${apiBase()}/documents/${docId}/state`, {
    headers: { authorization: `Bearer ${writerToken}` },
    tags: { name: 'state' },
  });
  if (!check(stateResponse, { 'S5 : document accessible (200)': (r) => r.status === 200 })) {
    throw new Error(
      `S5 — impossible de lire /documents/${docId}/state (HTTP ${stateResponse.status}).`,
    );
  }
  const sinceSeq = Number(JSON.parse(stateResponse.body).seq || 0);

  console.log(
    `S5 — document ${docId}, lien ${reusedLink ? 'réutilisé' : 'créé'} ${token}, ` +
      `${VISITORS} visiteurs, ${WRITERS} rédacteurs, depuis seq=${sinceSeq}`,
  );
  return { docId, token, run, sinceSeq, reusedLink };
}

/** Visiteur : un claim, avec un identifiant stable. */
export function visitorFlow(data) {
  const index = __VU * 100000 + __ITER;
  const visitor = visitorId('s5', index, data.run);

  const started = Date.now();
  const result = claim(data.token, visitor);
  claimLatency.add(Date.now() - started);

  if (result.status >= 500) {
    visitorErrors.add(1);
    return;
  }
  if (result.status === 429) return;

  if (result.state === 'ready' || result.state === 'waiting') {
    visitorReserved.add(1);
  } else if (result.state === 'exhausted') {
    visitorExhausted.add(1);
  }
}

/** Rédacteur : WebSocket, écriture, attente d'ack. */
export function writerFlow(data) {
  const token = __ENV.TOKEN2 || __ENV.TOKEN;
  const ticketResponse = http.post(
    `${apiBase()}/ws-ticket`,
    JSON.stringify({ documentId: data.docId }),
    {
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      tags: { name: 'ws-ticket' },
    },
  );
  // **201** et non 200 : `POST /ws-ticket` crée une ressource. La version
  // précédente exigeait 200 et comptait donc 100 % d'échecs de rédacteurs —
  // le même défaut que celui qui avait fait échouer S2.
  if (
    !check(ticketResponse, {
      'S5 : ticket rédacteur (201)': (r) => r.status === 201,
    })
  ) {
    writerTicketFailed.add(1);
    writerRejected.add(1);
    sleep(1);
    return;
  }

  const ticket = JSON.parse(ticketResponse.body).ticket;
  const session = runWriterSession({
    url:
      `${wsBase(__ENV.API_URL)}/ws?ticket=${encodeURIComponent(ticket)}` +
      `&documentId=${encodeURIComponent(data.docId)}`,
    docId: data.docId,
    sinceSeq: data.sinceSeq,
    count: 10,
    updateB64: __ENV.UPDATE_B64 || 'AQGd+OWCBAAEAQdjb250ZW50AXgA',
    opPrefix: `op_s5_${data.run}_${__VU}_${__ITER}`,
    ackWaitMs: Number(__ENV.ACK_WAIT_MS || 4000),
    onAck: (latency) => {
      ackLatency.add(latency);
      writerAcked.add(1);
    },
    onError: () => writerRejected.add(1),
  });

  // Sans ce compteur, le résumé afficherait 0 acquittement et laisserait croire
  // que les rédacteurs n'ont rien pu écrire.
  if (session.missing > 0) {
    writerMissing.add(session.missing);
    writerRejected.add(session.missing);
  }

  // Une courte pause hors connexion : on mesure le pic, pas une boucle tight.
  sleep(1);
}

/** Sonde `/status` : c'est le micro-cache nginx qui doit répondre. */
export function statusFlow(data) {
  const started = Date.now();
  const response = http.get(
    `${(__ENV.API_URL || 'http://localhost:4000').replace(/\/+$/, '')}/d/${data.token}/status`,
    { tags: { name: 'status' } },
  );
  statusLatency.add(Date.now() - started);

  check(response, {
    'S5 : /status répond 200': (r) => r.status === 200,
    'S5 : /status servi par le cache (HIT ou EXPIRED)': (r) => {
      const status = (r.headers['X-Cache-Status'] || r.headers['x-cache-status'] || '').toUpperCase();
      return status === 'HIT' || status === 'EXPIRED' || status === 'MISS';
    },
  });

  sleep(0.2);
}

/**
 * Seuils en échec, avec la contrainte et la valeur observée.
 *
 * Renvoyer `stdout` depuis `handleSummary` **supprime le résumé par défaut de
 * k6**, y compris le tableau `thresholds` qui explique pourquoi un scénario est
 * marqué `✗`. Au banc, S5 affichait `visitors ✗` avec « vérifications échouées
 * 0 » et aucun moyen de savoir quelle contrainte avait lâché : le diagnostic
 * avait été effacé par le confort du résumé. On le rétablit ici.
 */
function failedThresholds(m) {
  const out = [];
  for (const [name, metric] of Object.entries(m)) {
    for (const [expression, result] of Object.entries(metric.thresholds || {})) {
      if (!result.ok) out.push(`  SEUIL EN ÉCHEC : ${name} — ${expression}`);
    }
  }
  return out;
}

export function handleSummary(data) {
  const m = data.metrics;
  const lines = ['', '=== S5 — C5 : pic complet (visiteurs + rédacteurs) ==='];
  const add = (label, metric, stat) => {
    const value = m[metric]?.values?.[stat];
    if (value !== undefined) lines.push(`  ${label.padEnd(38)} ${Number(value).toFixed(2)}`);
  };

  add('visiteurs : réservations', 's5_visitor_reserved', 'count');
  add('visiteurs : refus « épuisé »', 's5_visitor_exhausted', 'count');
  add('visiteurs : erreurs 5xx', 's5_visitor_errors', 'count');
  add('rédacteurs : updates acquittés', 's5_writer_acked', 'count');
  add('rédacteurs : updates sans ack', 's5_writer_missing', 'count');
  add('rédacteurs : rejets', 's5_writer_rejected', 'count');
  add('rédacteurs : tickets non obtenus', 's5_writer_ticket_failed', 'count');
  add('latence claim p95 (ms)', 's5_claim_latency', 'p(95)');
  add('latence /status médiane (ms)', 's5_status_latency', 'med');
  add('latence /status p95 (ms)', 's5_status_latency', 'p(95)');
  add('latence ack p95 (ms)', 's5_ack_latency', 'p(95)');

  const checks = m.checks?.values;
  if (checks) {
    lines.push(`  vérifications réussies                 ${checks.passes}`);
    lines.push(`  vérifications échouées                 ${checks.fails}`);
  }

  // Le verdict est calculé ici, et non dans `setup`/`teardown` : seul
  // `handleSummary` reçoit les métriques agrégées de tous les VUs.
  const reserved = Number(m.s5_visitor_reserved?.values?.count ?? 0);
  const exhausted = Number(m.s5_visitor_exhausted?.values?.count ?? 0);
  const missing = Number(m.s5_writer_missing?.values?.count ?? 0);
  const ticketKo = Number(m.s5_writer_ticket_failed?.values?.count ?? 0);
  const visitorErr = Number(m.s5_visitor_errors?.values?.count ?? 0);
  const acked = Number(m.s5_writer_acked?.values?.count ?? 0);

  lines.push('');
  if (ticketKo > 0) {
    lines.push(
      `=> PRÉPARATION INCOMPLÈTE : ${ticketKo} tickets rédacteur refusés. ` +
        `Vérifier TOKEN2/TOKEN et l'appartenance au document.`,
    );
  } else if (missing > 0) {
    lines.push(
      `=> C5 NON PROUVÉE : ${missing} update(s) rédacteur sans acquittement sous le pic.`,
    );
  } else if (visitorErr > 0) {
    lines.push(
      `=> C5 NON PROUVÉE : ${visitorErr} erreur(s) 5xx côté visiteur — ` +
        `aucune requête ne doit échouer.`,
    );
  } else if (acked === 0) {
    lines.push('=> AUCUN UPDATE RÉDACTEUR ACQUITTÉ : le scénario rédacteur n\'a rien mesuré.');
  } else {
    // Le quota réel n'est connu que si le lien a été créé par ce script.
    const quota =
      data.setup_data?.reusedLink === true
        ? 'quota du lien réutilisé non vérifié'
        : `${reserved} / ${MAX_DOWNLOADS}`;
    lines.push(
      `=> C5 tenue : ${reserved} réservations (${quota}), ${exhausted} refus « épuisé » ` +
        `explicites, 0 erreur 5xx, ${acked} updates rédacteur acquittés, 0 perdu.`,
    );
  }

  lines.push(...failedThresholds(m));

  lines.push('');
  lines.push('Métriques système à relever sur CloudWatch pendant le test :');
  lines.push('  aws cloudwatch get-metric-statistics --namespace AWS/EC2 \\');
  lines.push('    --metric-name CPUUtilization --dimensions Name=InstanceId,Value=<id> \\');
  lines.push('    --start-time <début> --end-time <fin> --period 60 --statistics Maximum');
  lines.push('');

  return {
    stdout: lines.join('\n'),
    'tests/results/s5.json': JSON.stringify(data, null, 2),
  };
}
