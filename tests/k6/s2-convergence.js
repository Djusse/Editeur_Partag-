/**
 * S2 — C2 : N rédacteurs écrivent dans le même document, aucune modification
 * acceptée n'est perdue.
 *
 * Objectif du plan v7 : montée 50 → 100 → 300 rédacteurs.
 *
 * ── Ce que k6 mesure ici ────────────────────────────────────────────────────
 *   - le nombre d'updates **acquittés** (`ack` reçu pour l'`opId` émis) ;
 *   - l'absence d'updates sans acquittement après le sursis laissé aux `ack` ;
 *   - la latence d'acquittement sous charge.
 *
 * ── Ce que k6 ne peut pas mesurer ──────────────────────────────────────────
 * La contiguïté du journal et la convergence du **contenu**. k6 ne fait pas
 * tourner de client Yjs (moteur JS embarqué, sans `Buffer` ni modules Node).
 * Une version précédente prétendait vérifier la contiguïté du `seq` depuis k6 :
 * c'était faux, le `seq` est **global au document** et chaque VU n'en voit
 * qu'une tranche. Une suite « 41, 42, 43 » par VU est normale et ne dit rien
 * sur l'absence de trous.
 *
 * Ces deux preuves sont apportées par `tests/node/verify-convergence.mjs`,
 * exécuté après S2 : il reconstruit le document depuis le journal, vérifie les
 * `seq` contigus et compare deux reconstructions indépendantes.
 *
 * ── Profil de charge ───────────────────────────────────────────────────────
 * Connexion **persistante**, un update toutes les `PACE_MS` pendant `DURATION`.
 * Une version antérieure ouvrait une connexion par update : au banc, 110
 * itérations par seconde et par VU, soit 220 caractères/s — le quota de
 * 10 000 caractères partait en 45 s et le test mesurait le blocage de crédit.
 *
 * ── Crédit ─────────────────────────────────────────────────────────────────
 * 10 000 caractères par jour et par **e-mail**. Budget par VU :
 * `DURATION / PACE_MS` caractères. À 4 jetons, `ceil(WRITERS / 4)` VUs
 * partagent chaque quota : vérifier
 * `ceil(WRITERS/4) × (DURATION/1000) / (PACE_MS/1000) < 10000`.
 * À 50 rédacteurs, 1 s de cadence, 45 s : 50 caractères par compte.
 *
 * Usage :
 *   k6 run -e API_URL=http://<ip> -e TOKEN=<jwt1,jwt2,…> -e DOC_ID=<doc> \
 *          -e WRITERS=100 -e DURATION=45s -e PACE_MS=1000 tests/k6/s2-convergence.js
 */
import http from 'k6/http';
import { check, sleep } from 'k6';
import { Counter, Rate, Trend } from 'k6/metrics';
import { apiBase, requireEnv, runId } from './lib/common.js';
import { runWriterSession, wsBase } from './lib/ws.js';

const WRITERS = Number(__ENV.WRITERS || 100);
const DURATION = __ENV.DURATION || '45s';
/** Cadence d'écriture d'un rédacteur : un update par seconde. */
const PACE_MS = Number(__ENV.PACE_MS || 1000);
/** Sursis laissé aux `ack` en vol après l'arrêt de l'écriture. */
const ACK_WAIT_MS = Number(__ENV.ACK_WAIT_MS || 2500);

const durationMs = parseDuration(DURATION);

const acked = new Counter('s2_acked');
const rejected = new Counter('s2_rejected');
const missingAck = new Counter('s2_missing_ack');
const updatesReceived = new Counter('s2_updates_recu');
const ticketFailed = new Counter('s2_ticket_failed');
const joinFailed = new Counter('s2_join_failed');
const creditRefused = new Counter('s2_credit_refused');
const ackLatency = new Trend('s2_ack_latency', true);
const ackOk = new Rate('s2_all_acked');

export const options = {
  scenarios: {
    writers: {
      executor: 'constant-vus',
      vus: WRITERS,
      duration: DURATION,
      // Doit couvrir la durée de session + le sursis des `ack`, sinon k6 coupe
      // les connexions avant qu'on puisse compter les updates perdues.
      gracefulStop: `${Math.ceil((durationMs + ACK_WAIT_MS * 2) / 1000)}s`,
      tags: { scenario: 's2' },
    },
  },
  thresholds: {
    // Critère de préparation : sans ticket, le test ne mesure rien.
    's2_ticket_failed{scenario:s2}': ['count==0'],
    // Critère central de C2.
    's2_missing_ack{scenario:s2}': ['count==0'],
    's2_ack_latency{scenario:s2}': ['p(95)<4000'],
  },
  summaryTrendStats: ['avg', 'min', 'med', 'p(90)', 'p(95)', 'p(99)', 'max'],
};

/** « 45s », « 2m », « 90 » → millisecondes. */
function parseDuration(value) {
  const raw = String(value).trim();
  const match = /^(\d+(?:\.\d+)?)(ms|s|m|h)?$/.exec(raw);
  if (!match) return 45000;
  const amount = Number(match[1]);
  switch (match[2]) {
    case 'ms':
      return amount;
    case 'm':
      return amount * 60000;
    case 'h':
      return amount * 3600000;
    case 's':
    default:
      return amount * 1000;
  }
}

/** Jetons disponibles : `TOKEN=a,b,c` ou un seul. */
function tokens() {
  const raw = requireEnv('TOKEN');
  return raw
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean);
}

/**
 * Chaque VU reçoit son jeton.
 *
 * Le crédit étant compté **par e-mail**, répartir les VUs sur plusieurs jetons
 * est la seule façon de tester 300 rédacteurs sans épuiser un compte unique.
 */
function tokenFor(vu, list) {
  return list[(vu - 1) % list.length];
}

export function setup() {
  const docId = requireEnv('DOC_ID');
  const list = tokens();
  const token = list[0];

  // Point de départ de la lecture : le `seq` courant. Joindre avec 0 rejouerait
  // tout le journal à chaque connexion — mesuré à 90 513 messages reçus pour
  // 0 update acquitté lors du premier essai. Ce rattrapage intégral est un
  // comportement légitime du serveur, mais il n'a rien à faire dans la mesure
  // de C2 : il fausse la latence et sature la VM de charge.
  const stateResponse = http.get(`${apiBase()}/documents/${docId}/state`, {
    headers: { authorization: `Bearer ${token}` },
    tags: { name: 'state' },
  });

  if (
    !check(stateResponse, {
      'S2 : document accessible (200)': (r) => r.status === 200,
    })
  ) {
    // Échec au démarrage, message explicite : un scénario qui démarre sans
    // accès mesurerait des 403 et produirait des chiffres trompeurs.
    throw new Error(
      `S2 — impossible de lire /documents/${docId}/state (HTTP ${stateResponse.status}). ` +
        'Vérifier DOC_ID, la validité du jeton, et que le compte est membre du document.',
    );
  }

  const sinceSeq = Number(JSON.parse(stateResponse.body).seq || 0);

  // Budget de crédit : à documenter dans le rapport, et à comparer au plafond.
  const vusPerToken = Math.ceil(WRITERS / list.length);
  const charsPerVu = Math.ceil(durationMs / PACE_MS);
  const budget = vusPerToken * charsPerVu;
  const overBudget = budget > 10000;

  console.log(
    `S2 — document ${docId}, ${WRITERS} rédacteurs, ${list.length} jeton(s), ` +
      `${DURATION}, cadence ${PACE_MS} ms, depuis seq=${sinceSeq}` +
      ` — budget ${budget} caractères/compte${overBudget ? ' ⚠ DÉPASSE 10 000' : ''}`,
  );
  if (overBudget) {
    console.warn(
      `S2 — le budget de crédit dépasse le plafond quotidien (${budget} > 10 000). ` +
        'Augmenter PACE_MS, réduire DURATION, ou fournir plus de jetons : ' +
        'sinon les refus de crédit domineront la mesure.',
    );
  }

  return { docId, tokens: list, run: runId(), sinceSeq, budget, overBudget };
}

export default function (data) {
  const token = tokenFor(__VU, data.tokens);
  const ticketResponse = http.post(
    `${apiBase()}/ws-ticket`,
    JSON.stringify({ documentId: data.docId }),
    {
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      tags: { name: 'ws-ticket' },
    },
  );

  // L'API répond **201** (création), pas 200 : c'est ce qui a fait échouer la
  // première version, qui exigeait 200 et sortait donc avant le `sleep` —
  // 50 VUs ont bouclé 30 431 itérations en 45 s sans jamais se connecter.
  // Diagnostic explicite : 403 signifie « compte non membre du document »,
  // 401 « jeton invalide ». Ces deux causes ont des corrections opposées, et
  // les confondre fait perdre du temps.
  const ticketOk = check(ticketResponse, {
    'S2 : ticket obtenu (201)': (r) => r.status === 201,
    'S2 : compte membre du document': (r) => r.status !== 403,
    'S2 : jeton valide': (r) => r.status !== 401,
  });
  if (!ticketOk) {
    ticketFailed.add(1);
    if (ticketResponse.status === 403) {
      console.error(
        `S2 — 403 : le compte n'est pas membre de ${data.docId}. ` +
          'Utiliser tests/k6/mktokens.sh, qui ajoute chaque compte comme rédacteur.',
      );
    } else if (ticketResponse.status === 401) {
      console.error('S2 — 401 : jeton expiré ou invalide. Recréer avec mktoken.sh.');
    }
    // On patiente avant de réessayer : sans ce `sleep`, une erreur persistante
    // transforme la boucle k6 en salve de requêtes inutiles.
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
    paceMs: PACE_MS,
    durationMs,
    updateB64: __ENV.UPDATE_B64 || 'AQGd+OWCBAAEAQdjb250ZW50AXgA',
    opPrefix: `op_s2_${data.run}_${__VU}_${__ITER}`,
    ackWaitMs: ACK_WAIT_MS,
    onUpdate: () => updatesReceived.add(1),
    onAck: (latency) => {
      ackLatency.add(latency);
      acked.add(1);
    },
    onError: () => rejected.add(1),
  });

  if (!session.joined) joinFailed.add(1);
  if (session.missing > 0) {
    missingAck.add(session.missing);
    ackOk.add(false);
  } else if (!session.creditRefused) {
    ackOk.add(true);
  }
  if (session.creditRefused) creditRefused.add(1);
}

/**
 * Seuils en échec, avec la contrainte et la valeur observée.
 *
 * Renvoyer `stdout` depuis `handleSummary` **supprime le résumé par défaut de
 * k6**, y compris le tableau qui explique pourquoi un scénario est marqué `✗`.
 * Sans cette énumération, un `✗` n'a aucun diagnostic associé.
 */
function failedThresholds(metrics) {
  const out = [];
  for (const [name, metric] of Object.entries(metrics)) {
    for (const [expression, result] of Object.entries(metric.thresholds || {})) {
      if (!result.ok) out.push(`  SEUIL EN ÉCHEC : ${name} — ${expression}`);
    }
  }
  return out;
}

export function handleSummary(data) {
  const get = (name) => Number(data.metrics?.[name]?.values?.count ?? 0);
  const ack = get('s2_acked');
  const missing = get('s2_missing_ack');
  const ticketKo = get('s2_ticket_failed');
  const joinKo = get('s2_join_failed');
  const refused = get('s2_credit_refused');
  const rejectedCount = get('s2_rejected');
  const received = get('s2_updates_recu');
  const p95 = data.metrics?.['s2_ack_latency']?.values?.['p(95)'];

  const lines = ['', `=== S2 — C2 : ${WRITERS} rédacteurs simultanés ===`];
  lines.push(`  updates acquittés               ${ack}`);
  lines.push(`  updates reçus (diffusion)       ${received}`);
  lines.push(`  sans ack (perdus ?)             ${missing}`);
  lines.push(`  refus explicites (erreur)       ${rejectedCount}`);
  lines.push(`  dont crédit épuisé              ${refused}`);
  lines.push(`  tickets non obtenus             ${ticketKo}`);
  lines.push(`  connexions jamais jointes       ${joinKo}`);
  if (p95 !== undefined) lines.push(`  latence ack p95 (ms)            ${Number(p95).toFixed(1)}`);

  const checks = data.metrics?.checks?.values;
  if (checks) {
    lines.push(`  vérifications réussies          ${checks.passes}`);
    lines.push(`  vérifications échouées          ${checks.fails}`);
  }

  lines.push(...failedThresholds(data.metrics ?? {}));

  lines.push('');
  if (ticketKo > 0) {
    lines.push(
      `=> ECHEC DE PRÉPARATION : ${ticketKo} tickets non obtenus. Vérifier le jeton et l'accès au document.`,
    );
  } else if (joinKo > 0 && ack === 0) {
    lines.push(
      `=> AUCUNE CONNEXION JOINTE : le WebSocket s'ouvre mais ne répond pas \`joined\` (${joinKo} échecs).`,
    );
  } else if (missing > 0) {
    lines.push(`=> C2 NON PROUVÉE : ${missing} update(s) accepté(s) sans acquittement.`);
  } else if (ack === 0) {
    lines.push('=> AUCUN UPDATE ACQUITTÉ : le WebSocket ne s\'est pas ouvert, ou le document est vide.');
  } else if (refused > 0) {
    lines.push(
      `=> MESURE INVALIDÉE PAR LE CRÉDIT : ${refused} VU(s) arrêté(s) par épuisement de quota. ` +
        `${ack} updates acquittés, 0 perdu, mais le palier n'a pas été tenu jusqu'au bout — ` +
        `augmenter PACE_MS, réduire DURATION, ou fournir plus de jetons.`,
    );
  } else {
    lines.push(`=> C2 tenue sur cette charge : ${ack} updates acquittés, 0 perdu.`);
  }

  lines.push('');
  lines.push('Contiguïté du journal ET convergence du contenu, à exécuter après ce test :');
  lines.push(
    '  node tests/node/verify-convergence.mjs --api=<url>/api --token=<jwt> --doc=<doc>',
  );
  lines.push('');

  return {
    stdout: lines.join('\n'),
    // Le dossier doit exister : voir tests/k6/run.sh.
    [`tests/results/s2-${WRITERS}.json`]: JSON.stringify(data, null, 2),
  };
}

/*
 * L'update Base64 ci-dessus a été produit avec la vraie bibliothèque Yjs, puis
 * vérifié par le compteur du serveur :
 *
 *   cd backend && node --input-type=module -e "
 *     import * as Y from 'yjs';
 *     const d = new Y.Doc(); const u = [];
 *     d.on('update', (x) => u.push(x));
 *     d.getText('content').insert(0, 'x');
 *     console.log(Buffer.from(u[0]).toString('base64'));"
 *
 *   creditCost(Buffer.from(B64, 'base64')) → inserted=1, deleted=0, structs=1
 *
 * Pour en produire un autre (texte plus long, par exemple), remplacer 'x' et
 * transmettre le résultat par `-e UPDATE_B64=…`.
 */
