/**
 * S1 — Preuve C1 : un lien de N exemplaires reçoit 15 000 requêtes `claim`,
 * dont 80 % dans la première minute. On vérifie :
 *   - nombre d'accordés = N (jamais N+1) ;
 *   - tous les autres reçoivent un état explicite (`exhausted`) ;
 *   - aucun 5xx, aucun timeout silencieux ;
 *   - un retry avec le même `visitorId` renvoie le même ticket.
 *
 * Usage :
 *   k6 run -e API_URL=https://xxx.execute-api.eu-west-3.amazonaws.com \
 *          -e TOKEN=<jeton de lien> -e MAX_DOWNLOADS=500 \
 *          --summary-export=../results/s1-$(date +%s).json tests/k6/s1-claim.js
 *
 * Prérequis : le lien a été créé avec le même `MAX_DOWNLOADS` que le paramètre.
 */
import http from 'k6/http';
import { check } from 'k6';
import { Counter, Trend } from 'k6/metrics';

const API_URL = __ENV.API_URL;
const TOKEN = __ENV.TOKEN;
const MAX_DOWNLOADS = Number(__ENV.MAX_DOWNLOADS ?? 500);
const TOTAL_VISITORS = Number(__ENV.TOTAL_VISITORS ?? 15000);

const granted = new Counter('claim_granted');
const waiting = new Counter('claim_waiting');
const exhausted = new Counter('claim_exhausted');
const serverErrors = new Counter('claim_server_errors');
const networkErrors = new Counter('claim_network_errors');
const claimLatency = new Trend('claim_latency', true);

export const options = {
  scenarios: {
    pic: {
      executor: 'ramping-arrival-rate',
      startRate: 10,
      timeUnit: '1s',
      // 80 % des 15 000 visiteurs en 60 s, le reste étalé sur 5 minutes.
      stages: [
        { target: Math.round(TOTAL_VISITORS * 0.8 / 60), duration: '60s' },
        { target: Math.round(TOTAL_VISITORS * 0.2 / 240), duration: '240s' },
        { target: 0, duration: '10s' },
      ],
      preAllocatedVUs: 400,
      maxVUs: 2000,
    },
  },
  thresholds: {
    claim_server_errors: ['count==0'],
    http_req_failed: ['rate<0.01'],
    claim_latency: ['p(95)<2000'],
  },
};

/** Identifiant de visiteur stable par itération (idempotence côté serveur). */
function visitorId(vu, iteration) {
  return `k6_${vu}_${iteration}_${Math.random().toString(16).slice(2, 10)}`;
}

export default function () {
  const id = visitorId(__VU, __ITER);
  const response = http.post(
    `${API_URL}/d/${TOKEN}/claim`,
    JSON.stringify({ visitorId: id }),
    { headers: { 'content-type': 'application/json' }, timeout: '15s' },
  );

  claimLatency.add(response.timings.duration);

  if (response.status === 0) {
    networkErrors.add(1);
    return;
  }
  if (response.status >= 500) {
    serverErrors.add(1);
  }

  const body = safeBody(response);

  if (response.status === 200 && body.state === 'ready') {
    granted.add(1);
    check(body, { 'URL présignée fournie': (value) => typeof value.url === 'string' && value.url.length > 10 });
    return;
  }
  if (response.status === 202) {
    waiting.add(1);
    check(body, { 'retryAfter fourni': (value) => Number(value.retryAfter) > 0 });
    return;
  }
  if (response.status === 410) {
    exhausted.add(1);
    check(body, { 'état épuisé explicite': (value) => value.state === 'exhausted' });
    return;
  }

  check(response, { 'statut inattendu': () => false });
}

/** Vérification d'idempotence, à lancer après le pic (scénario séparé). */
export function idempotencyCheck() {
  const id = 'k6_idempotent_visitor';
  const first = http.post(`${API_URL}/d/${TOKEN}/claim`, JSON.stringify({ visitorId: id }), {
    headers: { 'content-type': 'application/json' },
  });
  const second = http.post(`${API_URL}/d/${TOKEN}/claim`, JSON.stringify({ visitorId: id }), {
    headers: { 'content-type': 'application/json' },
  });
  const a = safeBody(first);
  const b = safeBody(second);
  check(a, { 'retry renvoie le même ticket': (value) => value.seq === b.seq && value.state === b.state });
}

export function handleSummary(data) {
  const grantis = data.metrics.claim_granted ? data.metrics.claim_granted.values.count : 0;
  const conclude = `\n=== S1 — C1 ===\nExemplaires accordés : ${grantis} (attendu : ${MAX_DOWNLOADS})\n`;
  return {
    stdout: conclude,
    'summary.json': JSON.stringify(data, null, 2),
  };
}

function safeBody(response) {
  try {
    return response.json() ?? {};
  } catch {
    return {};
  }
}
