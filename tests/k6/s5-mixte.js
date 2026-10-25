/**
 * S5 — C5 : le pic complet, visiteurs **et** rédacteurs en même temps.
 *
 * Objectif du plan v7 : S1 (15 000 clics, 80 % en 60 s) **plus** 300 rédacteurs
 * dans le même document, simultanément.
 *
 * Ce que le test doit prouver :
 *   - les visiteurs obtiennent toujours un état explicite (`ready` / `waiting` /
 *     `exhausted`), jamais une erreur ;
 *   - les rédacteurs ne sont **pas perturbés** : leurs updates restent acquittés ;
 *   - le micro-cache de `/status` absorbe le pic (nginx, pas Node) ;
 *   - l'instance tient : CPU et mémoire restent dans les limites.
 *
 * Les métriques système (CPU, mémoire) ne sont **pas** visibles depuis k6 : il
 * faut les relever en parallèle sur CloudWatch. La commande est fournie en fin
 * de script.
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
 *          --summary-export=tests/results/s5.json tests/k6/s5-mixte.js
 */
import http from 'k6/http';
import { check, sleep } from 'k6';
import { Counter, Trend } from 'k6/metrics';
import {
  apiBase,
  authHeaders,
  claim,
  createLink,
  jsonHeaders,
  linkStatus,
  requireEnv,
  runId,
  visitorId,
} from './lib/common.js';

const VISITORS = Number(__ENV.VISITORS || 15000);
const MAX_DOWNLOADS = Number(__ENV.MAX_DOWNLOADS || 500);
const WRITERS = Number(__ENV.WRITERS || 300);
const WRITER_DURATION = __ENV.WRITER_DURATION || '120s';

const visitorReserved = new Counter('s5_visitor_reserved');
const visitorExhausted = new Counter('s5_visitor_exhausted');
const visitorErrors = new Counter('s5_visitor_errors');
const writerAcked = new Counter('s5_writer_acked');
const writerRejected = new Counter('s5_writer_rejected');
const claimLatency = new Trend('s5_claim_latency', true);
const statusLatency = new Trend('s5_status_latency', true);
const ackLatency = new Trend('s5_ack_latency', true);

let totalClaimed = 0;

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
        { target: 100, duration: '30s' }, // montée (20 %)
        { target: Math.round((VISITORS * 0.8) / 60), duration: '10s' },
        { target: Math.round((VISITORS * 0.8) / 60), duration: '60s' }, // pic 80 %
        { target: 0, duration: '15s' },
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
    'http_req_failed{scenario:s5-visitors}': ['rate<0.02'],
    'http_req_failed{scenario:s5-status}': ['rate<0.01'],
    's5_claim_latency{scenario:s5-visitors}': ['p(95)<3000'],
    's5_status_latency{scenario:s5-status}': ['p(95)<200'],
    // La preuve que le cache fonctionne : médiane très basse (nginx répond).
    's5_ack_latency{scenario:s5-writers}': ['p(95)<4000'],
  },
  summaryTrendStats: ['avg', 'min', 'med', 'p(90)', 'p(95)', 'p(99)', 'max'],
};

export function setup() {
  const docId = requireEnv('DOC_ID');
  const run = runId();
  // Le lien est créé une seule fois : c'est la cible du pic visiteur.
  const token = __ENV.LINK_TOKEN || createLink(docId, MAX_DOWNLOADS);
  if (!__ENV.LINK_TOKEN) {
    check(linkStatus(token), {
      'S5 : lien actif au départ': (r) => r.status === 200 && r.body.status === 'active',
    });
  }
  console.log(`S5 — document ${docId}, lien ${token}, ${VISITORS} visiteurs, ${WRITERS} rédacteurs`);
  return { docId, token, run };
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
    totalClaimed += 1;
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
  if (!check(ticketResponse, { 'S5 : ticket rédacteur (200)': (r) => r.status === 200 })) {
    writerRejected.add(1);
    return;
  }

  const ticket = JSON.parse(ticketResponse.body).ticket;
  const wsBase = (__ENV.API_URL || 'http://localhost:4000')
    .replace(/\/+$/, '')
    .replace(/^http/, 'ws');
  const socket = new WebSocket(
    `${wsBase}/ws?ticket=${encodeURIComponent(ticket)}&documentId=${encodeURIComponent(data.docId)}`,
  );

  const sentAt = new Map();
  let joined = false;

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
      for (let i = 0; i < 10; i++) sendOp();
      return;
    }
    if (message.type === 'ack' && Array.isArray(message.opIds)) {
      for (const opId of message.opIds) {
        const at = sentAt.get(opId);
        if (at !== undefined) {
          ackLatency.add(Date.now() - at);
          sentAt.delete(opId);
          // Sans ce compteur, le résumé afficherait 0 acquittement et laisserait
          // croire que les rédacteurs n'ont rien pu écrire.
          writerAcked.add(1);
        }
      }
      return;
    }
    if (message.type === 'error') {
      writerRejected.add(1);
      if (message.code === 'CREDIT_EXHAUSTED' || message.code === 'BLOCKED') socket.close();
    }
  };

  socket.onerror = () => writerRejected.add(1);

  function sendOp() {
    if (!joined) return;
    const opId = `op_s5_${data.run}_${__VU}_${__ITER}_${Math.random().toString(36).slice(2, 8)}`;
    sentAt.set(opId, Date.now());
    socket.send(
      JSON.stringify({
        type: 'update',
        opId,
        documentId: data.docId,
        // Même update vérifié que dans S2 : 1 caractère facturé.
        payload: __ENV.UPDATE_B64 || 'AQGd+OWCBAAEAQdjb250ZW50AXgA',
      }),
    );
  }

  sleep(2);
  socket.close();
  if (sentAt.size > 0) writerRejected.add(sentAt.size);
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

export function handleSummary(data) {
  const m = data.metrics;
  const lines = ['', '=== S5 — C5 : pic complet (visiteurs + rédacteurs) ==='];
  const add = (label, metric, stat) => {
    const value = m[metric]?.values?.[stat];
    if (value !== undefined) lines.push(`  ${label.padEnd(38)} ${Number(value).toFixed(2)}`);
  };

  add('visiteurs : réservations', 's5_visitor_reserved', 'count');
  add('visiteurs : refus « épuisé »', 's5_visitor_exhausted', 'count');
  add('visiteurs : erreurs', 's5_visitor_errors', 'count');
  add('rédacteurs : updates acquittés', 's5_writer_acked', 'count');
  add('rédacteurs : rejets', 's5_writer_rejected', 'count');
  add('latence claim p95 (ms)', 's5_claim_latency', 'p(95)');
  add('latence /status médiane (ms)', 's5_status_latency', 'med');
  add('latence /status p95 (ms)', 's5_status_latency', 'p(95)');
  add('latence ack p95 (ms)', 's5_ack_latency', 'p(95)');

  const checks = m.checks?.values;
  if (checks) {
    lines.push(`  vérifications réussies                 ${checks.passes}`);
    lines.push(`  vérifications échouées                 ${checks.fails}`);
  }

  lines.push('');
  lines.push('Métriques système à relever sur CloudWatch pendant le test :');
  lines.push('  aws cloudwatch get-metric-statistics --namespace AWS/EC2 \\');
  lines.push('    --metric-name CPUUtilization --dimensions Name=InstanceId,Value=<id> \\');
  lines.push('    --start-time <début> --end-time <fin> --period 60 --statistics Maximum');
  lines.push('');
  lines.push(`  réservations totales (k6) : ${totalClaimed} / ${MAX_DOWNLOADS}`);
  lines.push('');

  return {
    stdout: lines.join('\n'),
    'tests/results/s5.json': JSON.stringify(data, null, 2),
  };
}
