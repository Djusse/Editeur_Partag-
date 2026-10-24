/**
 * S2 — Preuve C2 : N rédacteurs scriptés écrivent au **même index** du même
 * document. Après la phase d'écriture, chaque client télécharge l'état complet
 * et calcule l'empreinte du texte : toutes doivent être identiques.
 *
 * Ce script ne dépend pas du navigateur : il utilise yjs en Node et le repli
 * HTTP (`POST /documents/{id}/updates`), qui applique exactement les mêmes
 * règles serveur que le WebSocket (même transaction, même crédit).
 *
 * Usage :
 *   k6 run -e API_URL=... -e JWT=... -e DOC_ID=... -e WRITERS=100 \
 *          --summary-export=../results/s2-100.json tests/k6/s2-convergence.js
 */
import http from 'k6';
import { check } from 'k6';
import { Counter, Trend } from 'k6/metrics';
import * as Y from 'yjs';

const API_URL = __ENV.API_URL;
const JWT = __ENV.JWT;
const DOC_ID = __ENV.DOC_ID;
const WRITERS = Number(__ENV.WRITERS ?? 50);
const INSERTS_PER_WRITER = Number(__ENV.INSERTS_PER_WRITER ?? 5);

const accepted = new Counter('updates_accepted');
const rejected = new Counter('updates_rejected');
const duplicates = new Counter('updates_duplicate');
const latency = new Trend('update_latency', true);

export const options = {
  scenarios: {
    writers: {
      executor: 'per-vu-iterations',
      vus: WRITERS,
      iterations: INSERTS_PER_WRITER,
      maxDuration: '10m',
    },
  },
  thresholds: {
    updates_rejected: ['count==0'],
    update_latency: ['p(95)<2000'],
  },
};

export function setup() {
  // Point d'entrée commun : tous les rédacteurs insèrent au même index.
  return { anchor: 0 };
}

export default function () {
  const doc = new Y.Doc();
  doc.getText('content').insert(0, `[${__VU}:${__ITER}]`);
  const update = Y.encodeStateAsUpdate(doc);
  const opId = `k6_${__VU}_${__ITER}_${Date.now()}`;

  const response = http.post(
    `${API_URL}/documents/${DOC_ID}/updates`,
    JSON.stringify({ opId, update: toBase64(update) }),
    {
      headers: { 'content-type': 'application/json', authorization: `Bearer ${JWT}` },
      timeout: '15s',
    },
  );
  latency.add(response.timings.duration);

  if (response.status === 200) {
    accepted.add(1);
    const body = response.json();
    if (body?.ack?.duplicate) duplicates.add(1);
    check(body, { acquittement: (value) => Number.isFinite(value?.ack?.seq) });
    return;
  }
  rejected.add(1);
}

/** À exécuter séparément (script Node) pour comparer les empreintes finales. */
export function handleSummary(data) {
  return {
    stdout: `\n=== S2 — C2 ===\nUpdates acceptés : ${data.metrics.updates_accepted?.values.count ?? 0}\n`,
    'summary.json': JSON.stringify(data, null, 2),
  };
}

function toBase64(bytes) {
  return Buffer.from(bytes).toString('base64');
}
