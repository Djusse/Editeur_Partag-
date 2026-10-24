/**
 * Verifie le parcours visiteur tel que le fait reellement le navigateur :
 *   - cree un document et un lien via l'API ;
 *   - appelle /d/{token}/status et /d/{token}/claim (URL construite comme le front) ;
 *   - attend le PDF et le telecharge ;
 *   - recharge en simulant un visiteur deja servi (meme visitorId).
 *
 * Ce test valide le CONTRAT D'URL, pas seulement les fonctions metier.
 */
import * as Y from 'yjs';

const API = 'http://localhost:4000';
// Reproduit exactement ce que fait le front : VISITOR_BASE = API_BASE sans /api
const API_BASE = 'http://localhost:4000/api';
const VISITOR_BASE = API_BASE.replace(/\/api$/, '');

let ok = 0;
let ko = 0;

const check = (label, cond, extra = '') => {
  if (cond) {
    console.log(`  OK   ${label}${extra ? ' - ' + extra : ''}`);
    ok++;
  } else {
    console.log(`  FAIL ${label}${extra ? ' - ' + extra : ''}`);
    ko++;
  }
};

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function json(url, opts = {}) {
  const response = await fetch(url, {
    ...opts,
    headers: { 'content-type': 'application/json', ...(opts.headers || {}) },
  });
  const text = await response.text();
  let body = {};
  try {
    body = JSON.parse(text);
  } catch {
    body = {};
  }
  return { status: response.status, body };
}

// 0. Contrat d'URL
check('VISITOR_BASE ne contient pas /api', !VISITOR_BASE.endsWith('/api'), VISITOR_BASE);

// 1. Preparation via l'API
const session = await json(`${API_BASE}/session`, {
  method: 'POST',
  body: JSON.stringify({ name: 'Lien', email: 'lien@exemple.cm' }),
});
const auth = { authorization: `Bearer ${session.body.token}` };

const doc = await json(`${API_BASE}/documents`, {
  method: 'POST',
  headers: auth,
  body: JSON.stringify({ title: 'Document avec lien' }),
});
const docId = doc.body.id;

const ydoc = new Y.Doc();
ydoc.getText('content').insert(0, 'Contenu du document partagé');
await json(`${API_BASE}/documents/${docId}/updates`, {
  method: 'POST',
  headers: auth,
  body: JSON.stringify({
    opId: 'op_lien_1',
    update: Buffer.from(Y.encodeStateAsUpdate(ydoc)).toString('base64'),
  }),
});

const link = await json(`${API_BASE}/documents/${docId}/links`, {
  method: 'POST',
  headers: auth,
  body: JSON.stringify({ maxDownloads: 2 }),
});
const token = link.body.token;
check('lien créé', Boolean(token), `token=${token}`);

// 2. Le front appelle /d/... (sans /api)
const statusUrl = `${VISITOR_BASE}/d/${token}/status`;
check('URL de statut construite', statusUrl === `${API}/d/${token}/status`, statusUrl);

const status = await json(statusUrl);
check('GET status -> 200', status.status === 200, `HTTP ${status.status}`);
check('statut actif', status.body.status === 'active', status.body.status);
check('titre présent', status.body.title === 'Document avec lien', status.body.title);
check('3 restants', status.body.remaining === 2, `${status.body.remaining}`);

// 3. Claim
const visitorId = 'visiteur_lien_abcdef';
const claim = await json(`${VISITOR_BASE}/d/${token}/claim`, {
  method: 'POST',
  body: JSON.stringify({ visitorId }),
});
check('claim -> 202 waiting', claim.status === 202 && claim.body.state === 'waiting', claim.body.state);

// 4. Attente du PDF
let file = null;
for (let attempt = 0; attempt < 10; attempt++) {
  await wait(700);
  file = await json(`${VISITOR_BASE}/d/${token}/file?visitorId=${visitorId}`);
  if (file.status === 200) break;
}
check('file -> PDF prêt', file.status === 200 && file.body.state === 'ready', file.body.url ?? '');

// 5. Téléchargement réel
if (file.body.url) {
  const pdf = await fetch(API + file.body.url);
  const buffer = Buffer.from(await pdf.arrayBuffer());
  check('PDF téléchargeable', buffer.subarray(0, 5).toString() === '%PDF-', `${buffer.length} octets`);
}

// 6. Rechargement du même visiteur : jamais « épuisé », aucun exemplaire de plus
await json(`${VISITOR_BASE}/d/${token}/claim`, {
  method: 'POST',
  body: JSON.stringify({ visitorId: 'visiteur_lien_ghijkl' }),
});
await wait(300);
const recharge = await json(`${VISITOR_BASE}/d/${token}/claim`, {
  method: 'POST',
  body: JSON.stringify({ visitorId }),
});
check('rechargement -> pas épuisé', recharge.status !== 410, `HTTP ${recharge.status}`);

const statusFinal = await json(statusUrl);
check(
  'compteur cohérent après rechargement',
  statusFinal.body.remaining === 0,
  `remaining=${statusFinal.body.remaining}`,
);

console.log(`\n=== ${ok} OK, ${ko} FAIL ===`);
process.exit(ko === 0 ? 0 : 1);
