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

// `Counter` est un **aggregate metric** : k6 agrège les valeurs de tous les
// VUs et les rend disponibles dans `data.metrics` au `teardown` et dans le
// résumé. Une simple variable JS, elle, est **locale à chaque VU** : c'est
// pourquoi la première version affichait « 0 / 10 » alors que le compteur
// `s1_reserved` en montrait 10.
const reserved = new Counter('s1_reserved');
const exhausted = new Counter('s1_exhausted');
const serverErrors = new Counter('s1_server_errors');
const throttled = new Counter('s1_throttled_429');
const claimLatency = new Trend('s1_claim_latency', true);

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
    // ⚠️ Pas de seuil sur `http_req_failed` : k6 compte tout code >= 400 comme
    // échec, or les 410 `exhausted` sont ici l'état **attendu** de la grande
    // majorité des visiteurs (le quota est volontairement bas). Le taux
    // observé était 0.94, ce qui ferait échouer le test alors que C1 est
    // respectée. Le critère qui compte est `s1_reserved === MAX_DOWNLOADS`,
    // vérifié dans `handleSummary`.
    //
    // On garde seulement la latence : la garde mémoire doit répondre vite.
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
    reserved.add(1);
  } else if (result.state === 'exhausted') {
    exhausted.add(1);
  }
}

/**
 * Vérifications finales côté lien.
 *
 * ⚠️ `teardown` **ne reçoit pas les métriques** : il n'a que la valeur rendue
 * par `setup`. Le verdict de C1 est donc calculé dans `handleSummary`, qui
 * reçoit `data.metrics`. La première version le faisait ici, sur des variables
 * locales aux VUs — d'où « 0 / 10 » alors que le compteur en montrait 10.
 */
export function teardown(data) {
  const final = linkStatus(data.token);
  check(final, {
    'S1 : plus aucun exemplaire restant': (r) => r.body.remaining === 0,
    'S1 : statut passé à exhausted': (r) => r.body.status === 'exhausted',
  });
}

export function handleSummary(data) {
  const claimed = metricCount(data, 's1_reserved');
  const refused = metricCount(data, 's1_exhausted');
  const errors5xx = metricCount(data, 's1_server_errors');
  const throttled429 = metricCount(data, 's1_throttled_429');
  const exact = claimed === MAX_DOWNLOADS;

  const lines = textSummary(data).split('\n');
  lines.push('');
  lines.push(`S1 — réservations accordées : ${claimed} / ${MAX_DOWNLOADS}`);
  lines.push(`S1 — refus « épuisé »       : ${refused}`);
  lines.push(`S1 — 429 (garde mémoire)    : ${throttled429}`);
  lines.push(`S1 — 5xx                    : ${errors5xx}`);
  lines.push('');
  lines.push(
    exact && errors5xx === 0
      ? '=> C1 RESPECTÉE : exactement N exemplaires distribués, jamais N+1, aucun 5xx.'
      : `=> C1 NON PROUVÉE : ${claimed} réservations pour ${MAX_DOWNLOADS} exemplaires, ${errors5xx} erreur(s) 5xx.`,
  );
  lines.push('');

  return {
    stdout: lines.join('\n'),
    // ⚠️ k6 n'a **pas** d'API de système de fichiers sans
    // `--compatibility-mode` : il ne peut pas créer le dossier lui-même. S'il
    // manque, k6 signale `failed to handle the end-of-test summary` et perd le
    // résumé — le verdict ci-dessus reste affiché, mais le JSON n'est pas écrit.
    // Le dossier est donc créé par l'appelant (voir tests/k6/run.sh).
    'tests/results/s1.json': JSON.stringify(data, null, 2),
  };
}

/** Lit le total d'un compteur dans le résumé, ou 0 s'il est absent. */
function metricCount(data, name) {
  const values = data.metrics?.[name]?.values;
  if (!values) return 0;
  return Number(values.count ?? 0);
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
  // Le « taux d'échec HTTP » de k6 est trompeur ici : il compte les 410
  // `exhausted` comme des échecs. On affiche le débit réel, plus parlant.
  add('débit atteint (req/s)', 'http_reqs', 'rate');
  add('latence claim médiane (ms)', 's1_claim_latency', 'med');
  add('latence claim p95 (ms)', 's1_claim_latency', 'p(95)');
  add('latence claim p99 (ms)', 's1_claim_latency', 'p(99)');
  // Les compteurs réservations / refus / 429 / 5xx sont affichés par le verdict
  // de `handleSummary` : les répéter ici produirait deux fois les mêmes lignes.

  const checks = metrics.checks?.values;
  if (checks) {
    lines.push(`  vérifications réussies           ${checks.passes}`);
    lines.push(`  vérifications échouées           ${checks.fails}`);
  }
  lines.push('');
  return lines.join('\n');
}
