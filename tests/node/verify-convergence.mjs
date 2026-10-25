/**
 * Vérification de convergence après S2 (C2) — la preuve que k6 ne peut pas
 * apporter.
 *
 * k6 ne fait pas tourner de client Yjs : il prouve que **chaque update envoyé a
 * été acquitté**, pas que le **contenu** est le même partout. Ce script comble
 * ce trou en reconstruisant le document depuis le journal serveur.
 *
 * ── Ce qui était faux dans la version précédente ────────────────────────────
 * Le script interrogeait `GET /api/documents/{id}/state` en attendant
 * `{ snapshot, updates: [{ seq, payload }] }`. Cette réponse **n'existe pas** :
 * l'endpoint renvoie `{ seq, state }`, un état Yjs déjà compacté, et le journal
 * paginé est servi par `GET /api/documents/{id}/updates?since=N` sous la forme
 * `{ updates: [{ seq, payload }] }`. Le script aurait donc levé
 * `state.updates is not iterable` — ou, pire, n'aurait jamais été exécuté et
 * aurait laissé croire que la convergence était vérifiée.
 *
 * ── Ce que fait cette version ──────────────────────────────────────────────
 *  1. `GET /state` → `{ seq, state }` : l'état compacté (base Yjs).
 *  2. `GET /updates?since=0` paginé jusqu'à `updates.length === 0` : le journal.
 *  3. Contrôle de **contiguïté** du `seq` sur l'ensemble du journal.
 *  4. Reconstruction du document par `Y.applyUpdate` successifs, dans l'ordre.
 *  5. Reconstruction **indépendante** une seconde fois, et comparaison des
 *     empreintes SHA-256 du texte obtenu : deux chemins de reconstruction qui
 *     tombent sur le même contenu sont la définition opérationnelle de la
 *     convergence.
 *  6. Cohérence de comptabilité : `state.seq` du serveur = dernier `seq` du
 *     journal. Un écart signalerait une écriture acceptée mais non journalisée.
 *
 * Usage :
 *   node tests/node/verify-convergence.mjs --api=http://<ip>/api \
 *        --token=<jwt> --doc=<docId>
 *
 * Sortie : un rapport JSON, code de sortie 0 si convergence prouvée, 1 sinon.
 */
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';

const args = Object.fromEntries(
  process.argv.slice(2).map((arg) => {
    const [key, value] = arg.replace(/^--/, '').split('=');
    return [key, value];
  }),
);

const API = (args.api || '').replace(/\/+$/, '');
const TOKEN = args.token;
const DOC_ID = args.doc;

if (!API || !TOKEN || !DOC_ID) {
  console.error(
    'Usage : node verify-convergence.mjs --api=URL --token=JWT --doc=DOC_ID\n' +
      '  --api inclut le préfixe /api (ex. http://13.53.160.209/api)',
  );
  process.exit(2);
}

/**
 * `yjs` vit dans `backend/node_modules`, pas à la racine du dépôt : un simple
 * `import('yjs')` échoue quand on lance le script depuis `tests/node/`, car
 * Node remonte l'arborescence **du fichier**, pas du répertoire courant. La
 * première version se contentait de ce `import` et sortait donc en erreur —
 * la vérification de convergence n'aurait jamais tourné.
 *
 * On essaie donc, dans l'ordre : résolution normale, puis `backend/`, puis la
 * racine. Le premier qui répond gagne.
 */
async function loadYjs() {
  try {
    return await import('yjs');
  } catch {
    /* on tente les emplacements connus */
  }
  for (const base of [
    new URL('../../backend/package.json', import.meta.url),
    new URL('../package.json', import.meta.url),
  ]) {
    try {
      return createRequire(base)('yjs');
    } catch {
      /* emplacement suivant */
    }
  }
  return null;
}

const Y = await loadYjs();
if (!Y) {
  console.error(
    'yjs introuvable : ni à la racine, ni dans backend/node_modules.\n' +
      'Installer avec : cd backend && npm install',
  );
  process.exit(2);
}

/** État compacté : c'est la base de la reconstruction. */
const state = await fetchJson(`${API}/documents/${DOC_ID}/state`);
if (typeof state.seq !== 'number' || typeof state.state !== 'string') {
  console.error(
    `Réponse inattendue de /state : clés ${Object.keys(state).join(', ')}. ` +
      'Attendu { seq, state }.',
  );
  process.exit(2);
}

/**
 * Journal complet, page après page.
 *
 * `GET /documents/:id/updates?since=N` ne prend **que** `since` : la taille de
 * page est fixée à 500 côté serveur (`manager.fetchUpdates`). On boucle donc en
 * déplaçant `since` sur le dernier `seq` reçu, sans paramètre `limit` inutile.
 */
const journal = [];
let since = 0;
for (;;) {
  const page = await fetchJson(`${API}/documents/${DOC_ID}/updates?since=${since}`);
  const batch = Array.isArray(page.updates) ? page.updates : [];
  if (batch.length === 0) break;
  journal.push(...batch);
  const last = batch[batch.length - 1].seq;
  if (typeof last !== 'number' || last <= since) {
    // Sans ce garde-fou, une pagination défaillante boucle indéfiniment.
    console.error(`Pagination bloquée : seq ${last} après since ${since}.`);
    process.exit(2);
  }
  since = last;
}

/**
 * Contiguïté : le journal doit former 1, 2, 3, … sans trou.
 *
 * Un trou signifie qu'une écriture a été acceptée sans être journalisée — donc
 * qu'un update acquitté est perdu, ce qui viole C2 directement.
 */
const gaps = [];
for (let index = 0; index < journal.length; index++) {
  const expected = index === 0 ? journal[0].seq : journal[index - 1].seq + 1;
  if (journal[index].seq !== expected) {
    gaps.push({ attendu: expected, trouve: journal[index].seq });
  }
}

/** Reconstruction n° 1 : état compacté + journal, dans l'ordre. */
function rebuild() {
  const doc = new Y.Doc();
  if (state.state.length > 0) Y.applyUpdate(doc, fromBase64(state.state));
  for (const entry of journal) Y.applyUpdate(doc, fromBase64(entry.payload));
  return doc.getText('content').toString();
}

const text = rebuild();
const fingerprint = createHash('sha256').update(text).digest('hex');

/** Reconstruction n° 2, indépendante : même contenu attendu. */
const secondFingerprint = createHash('sha256').update(rebuild()).digest('hex');

/**
 * Cohérence de séquence : le dernier `seq` journalisé doit être celui
 * qu'annonce `/state`. Un écart = écriture acceptée mais non journalisée.
 */
const lastSeq = journal.length > 0 ? journal[journal.length - 1].seq : 0;
const seqCoherent = lastSeq === state.seq;

const report = {
  docId: DOC_ID,
  seqServeur: state.seq,
  seqDernierJournal: lastSeq,
  entreesJournal: journal.length,
  trous: gaps.length,
  premiersTrous: gaps.slice(0, 5),
  longueurFinale: text.length,
  empreinte: fingerprint,
  reconstructionStable: fingerprint === secondFingerprint,
  seqCoherent,
};

report.verdict =
  gaps.length === 0 && seqCoherent && fingerprint === secondFingerprint
    ? 'CONVERGENCE OK'
    : 'ÉCHEC';

console.log(JSON.stringify(report, null, 2));
process.exit(report.verdict === 'CONVERGENCE OK' ? 0 : 1);

async function fetchJson(url) {
  const response = await fetch(url, { headers: { authorization: `Bearer ${TOKEN}` } });
  if (!response.ok) {
    const body = await response.text().catch(() => '');
    throw new Error(`HTTP ${response.status} sur ${url} — ${body.slice(0, 200)}`);
  }
  return response.json();
}

function fromBase64(value) {
  return new Uint8Array(Buffer.from(value, 'base64'));
}
