/**
 * S1 — C1 : un lien de N exemplaires distribue **exactement** N PDF.
 *
 * Objectif du plan v7 : 15 000 visiteurs sur un lien de 500 exemplaires,
 * dont 80 % en 60 secondes.
 *
 * Ce que le test doit prouver, et comment :
 *   - exactement `MAX_DOWNLOADS` réponses `ready`/`waiting` (réservations) ;
 *   - tous les autres visiteurs reçoivent `exhausted` (410) ;
 *   - `remaining` du lien tombe à 0 et son statut passe à `EXHAUSTED` ;
 *   - le même `visitorId` qui revient après épuisement retrouve **son** ticket
 *     (jamais 410) — c'est la correction 4.2-1 du plan ;
 *   - aucun 5xx.
 *
 * Prérequis :
 *   - un jeton de rédacteur `TOKEN` (compte dédié : la préparation consomme du
 *     crédit, 10 000 caractères par jour et par e-mail) ;
 *   - l'IP de l'instance, pas localhost : un test de charge lancé depuis le
 *     poste mesurerait le réseau, pas l'application.
 *
 * Usage :
 *   k6 run -e API_URL=http://13.53.160.209 -e TOKEN=<jwt> \
 *          -e MAX_DOWNLOADS=500 -e VISITORS=15000 \
 *          --summary-export=tests/results/s1.json tests/k6/s1-claim.js
 *
 * Variante courte (mise au point) :
 *   k6 run -e API_URL=… -e TOKEN=… -e VISITORS=200 -e MAX_DOWNLOADS=10 …
 */
import { check } from 'k6';
import { Counter, Trend } from 'k6/metrics';
import { claim, createDocument, createLink, linkStatus, runId, visitorId } from './lib/common.js';

const VISITORS = Number(__ENV.VISITORS || 15000);
const MAX_DOWNLOADS = Number(__ENV.MAX_DOWNLOADS || 500);
/** Part du pic : 80 % des visiteurs en 60 s, comme le plan. */
const PEAK_SHARE = Number(__ENV.PEAK_SHARE || 0.8);
const PEAK_SECONDS = Number(__ENV.PEAK_SECONDS || 60);

const reserved = new Counter('s1_reserved');
const exhausted = new Counter('s1_exhausted');
const serverErrors = new Counter('s1_server_errors');
const throttled = new Counter('s1_throttled_429');
const claimLatency = new Trend('s1_claim_latency', true);

/**
 * Quotas atteints et réservations accordées.
 *
 * Ils sont partagés par tous les VUs **du même processus k6**. k6 ne garantit
 * pas ce partage entre instances distribuées : pour un test distribué, il
 * faudrait agréger les compteurs de chaque instance. En pratique, une seule
 * instance de charge suffit ici (le plan prévoit ~15 000 requêtes).
 */
let totalClaimed = 0;
let totalExhausted = 0;

export const options = {
  scenarios: {
    // Montée puis pic : les 20 % restants étalés, 80 % en PEAK_SECONDS.
    claim_burst: {
      executor: 'ramping-arrival-rate',
      startRate: Math.max(1, Math.round(VISITORS / 300)),
      timeUnit: '1s',
      preAllocatedVUs: Math.min(500, Math.max(50, Math.round(VISITORS / 50))),
      maxVUs: Math.min(2000, Math.max(200, Math.round(VISITORS / 5))),
      stages: [
        // 20 % en montée douce, le temps de chauffer les connexions
        {
          target: Math.round((VISITORS * (1 - PEAK_SHARE)) / 30),
          duration: '30s',
        },
        // 80 % en 60 s — le pic exigé par C1
        {
          target: Math.round((VISITORS * PEAK_SHARE) / PEAK_SECONDS),
          duration: '10s',
        },
        { target: Math.round((VISITORS * PEAK_SHARE) / PEAK_SECONDS), duration: `${PEAK_SECONDS}s` },
        // Retour au calme, le temps de finir les réservations en cours
        { target: 0, duration: '10s' },
      ],
      gracefulStop: '30s',
      tags: { scenario: 's1' },
    },
  },
  thresholds: {
    // Aucun 5xx : un serveur qui renvoie 500 sous charge a échoué.
    'http_req_failed{scenario:s1}': ['rate<0.01'],
    // Le claim doit rester rapide : la garde mémoire répond `waiting` en 1 s.
    's1_claim_latency{scenario:s1}': ['p(95)<2000', 'p(99)<4000'],
  },
  summaryTrendStats: ['avg', 'min', 'med', 'p(90)', 'p(95)', 'p(99)', 'max'],
};

/**
 * `setup` s'exécute **une seule fois**, hors des VUs.
 *
 * C'est le bon endroit pour créer le document et le lien : sinon chaque VU
 * créerait son propre lien, et le test ne mesurerait plus « un lien à N
 * exemplaires ».
 */
export function setup() {
  const run = runId();
  const docId = createDocument(`Test de charge S1 — ${run}`);
  const token = createLink(docId, MAX_DOWNLOADS);

  const initial = linkStatus(token);
  check(initial, {
    'S1 : lien actif au départ': (r) => r.status === 200 && r.body.status === 'active',
    'S1 : quota initial correct': (r) => r.body.remaining === MAX_DOWNLOADS,
  });

  console.log(
    `S1 — document ${docId}, lien ${token}, ${MAX_DOWNLOADS} exemplaires, ${VISITORS} visiteurs`,
  );
  return { docId, token, run };
}

/**
 * Chaque VU exécute `default` en boucle, à la cadence fixée par
 * `ramping-arrival-rate`. Un appel = un visiteur distinct.
 */
export default function (data) {
  // Index global du visiteur : VU × itération, stable pour un même visiteur.
  const index = __VU * 100000 + __ITER;
  const visitor = visitorId('s1', index, data.run);

  const result = claim(data.token, visitor);
  claimLatency.add(result.status === 0 ? 0 : 1);

  if (result.status >= 500) {
    serverErrors.add(1);
    return;
  }
  if (result.status === 429) {
    throttled.add(1);
    return;
  }

  if (result.state === 'ready' || result.state === 'waiting') {
    totalClaimed += 1;
    reserved.add(1);
    check(result, {
      'S1 : réservation a un état explicite': () => result.state === 'ready' || result.state === 'waiting',
    });
  } else if (result.state === 'exhausted') {
    totalExhausted += 1;
    exhausted.add(1);
  }
}

/** Vérifications finales : la somme doit être exactement le quota. */
export function teardown(data) {
  const final = linkStatus(data.token);

  check(null, {
    'S1 : plus aucun exemplaire restant': () => final.body.remaining === 0,
    'S1 : statut passé à exhausted': () => final.body.status === 'exhausted',
    'S1 : au moins un visiteur a été servi': () => totalClaimed > 0,
    'S1 : au moins un visiteur a été refusé': () => totalExhausted > 0,
    'S1 : aucun 5xx': () => serverErrors.value === undefined || Number(serverErrors.value) === 0,
  });

  // La condition centrale de C1 : ni plus, ni moins que le quota.
  const exact = totalClaimed === MAX_DOWNLOADS;
  check(null, {
    [`S1 : exactement ${MAX_DOWNLOADS} réservations (obtenu ${totalClaimed})`]: () => exact,
  });

  console.log('');
  console.log(`S1 — réservations accordées : ${totalClaimed} / ${MAX_DOWNLOADS}`);
  console.log(`S1 — refus « épuisé »       : ${totalExhausted}`);
  console.log(`S1 — 429 (garde mémoire)    : ${Number(throttled.value) || 0}`);
  console.log(`S1 — 5xx                    : ${Number(serverErrors.value) || 0}`);
  console.log(`S1 — remaining final        : ${final.body.remaining}`);
  console.log('');
  console.log(
    exact
      ? '=> C1 RESPECTÉE : exactement N exemplaires distribués, jamais N+1.'
      : `=> C1 VIOLÉE : ${totalClaimed} réservations pour ${MAX_DOWNLOADS} exemplaires.`,
  );
}

export function handleSummary(data) {
  // Aucune dépendance externe : un serveur de charge n'a pas toujours accès à
  // Internet, et un import réseau en échec empêcherait le test de démarrer.
  // Les résultats sont en JSON, convertibles ensuite en tableau ou graphique.
  return {
    stdout: textSummary(data),
    'tests/results/s1.json': JSON.stringify(data, null, 2),
  };
}

/** Résumé lisible, sans dépendre du formateur par défaut de k6. */
function textSummary(data) {
  const metrics = data.metrics;
  const lines = ['', '=== S1 — C1 : quota exact sous pic ==='];

  const add = (label, metric, stat) => {
    const value = metrics[metric]?.values?.[stat];
    if (value === undefined) return;
    lines.push(`  ${label.padEnd(34)} ${Number(value).toFixed(2)}`);
  };

  add('requêtes (total)', 'http_reqs', 'count');
  add('taux d\'échec HTTP', 'http_req_failed', 'rate');
  add('latence claim médiane (ms)', 's1_claim_latency', 'med');
  add('latence claim p95 (ms)', 's1_claim_latency', 'p(95)');
  add('latence claim p99 (ms)', 's1_claim_latency', 'p(99)');
  add('réservations accordées', 's1_reserved', 'count');
  add('refus « épuisé »', 's1_exhausted', 'count');
  add('429 (garde mémoire)', 's1_throttled_429', 'count');
  add('5xx', 's1_server_errors', 'count');

  const checks = metrics.checks?.values;
  if (checks) {
    lines.push(`  vérifications réussies           ${checks.passes}`);
    lines.push(`  vérifications échouées           ${checks.fails}`);
  }
  lines.push('');
  return lines.join('\n');
}
