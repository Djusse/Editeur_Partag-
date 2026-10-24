/**
 * Non-regression : les routes visiteur sont a la RACINE, pas sous /api.
 *
 * Bug corrige : le client appelait `/api/d/{token}/status`, le serveur attend
 * `/d/{token}/status`. Un lien parfaitement valide affichait donc
 * « Ce lien n'existe pas ou n'est plus valide ».
 *
 * Ce test verifie les deux cotes : le serveur expose bien /d/... et refuse
 * /api/d/..., ce qui documente le contrat.
 */
import * as Y from 'yjs';

const API = 'http://localhost:4000';
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

async function json(path, opts = {}) {
  const response = await fetch(API + path, {
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

// Preparation : un document et un lien.
const session = await json('/api/session', {
  method: 'POST',
  body: JSON.stringify({ name: 'Visiteur', email: 'visiteur@exemple.cm' }),
});
const auth = { authorization: `Bearer ${session.body.token}` };

const doc = await json('/api/documents', {
  method: 'POST',
  headers: auth,
  body: JSON.stringify({ title: 'Test routes visiteur' }),
});
const docId = doc.body.id;

const link = await json(`/api/documents/${docId}/links`, {
  method: 'POST',
  headers: auth,
  body: JSON.stringify({ maxDownloads: 5 }),
});
const token = link.body.token;
const visitorId = 'visiteur_test_abcdef';

// 1. La route correcte répond.
const status = await json(`/d/${token}/status`);
check('GET /d/{token}/status -> 200', status.status === 200, `status=${status.body.status}`);
check('titre renvoyé', typeof status.body.title === 'string', status.body.title);
check('restants renvoyés', status.body.remaining === 5, `remaining=${status.body.remaining}`);

// 2. La route préfixée par /api N'EXISTE PAS (cause du bug côté client).
const wrong = await json(`/api/d/${token}/status`);
check('GET /api/d/... -> 404 (contrat)', wrong.status === 404, `HTTP ${wrong.status}`);

// 3. Claim à la racine.
const claim = await json(`/d/${token}/claim`, {
  method: 'POST',
  body: JSON.stringify({ visitorId }),
});
check('POST /d/{token}/claim -> 202', claim.status === 202 && claim.body.state === 'waiting');

// 4. Sans préfixe /api, le claim fonctionne aussi.
const wrongClaim = await json(`/api/d/${token}/claim`, {
  method: 'POST',
  body: JSON.stringify({ visitorId: 'autre_visiteur_xyz' }),
});
check('POST /api/d/.../claim -> 404 (contrat)', wrongClaim.status === 404, `HTTP ${wrongClaim.status}`);

// 5. Le lien reste consommable : un seul ticket créé.
const debug = await json('/__debug');
check('un seul ticket enregistré', debug.body.tables.Tickets === 1, `${debug.body.tables.Tickets}`);

console.log(`\n=== ${ok} OK, ${ko} FAIL ===`);
process.exit(ko === 0 ? 0 : 1);
