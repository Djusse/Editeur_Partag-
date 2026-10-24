/**
 * Verifie le cycle complet des versions :
 *   ecriture -> enregistrement -> nouvelle ecriture -> liste -> restauration.
 *
 * C'est le scenario qui manquait : le snapshot S3 etait ecrit mais aucune ligne
 * n'etait ajoutee a la table Versions, donc la modale affichait toujours
 * « Aucune version enregistree ».
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

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

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

/**
 * Écrit du texte dans le document.
 *
 * `suffix` rend l'`opId` unique à chaque exécution : le serveur déduplique
 * (`OpIds`), donc un `opId` constant serait considéré comme rejoué au deuxième
 * passage et l'update ne serait pas appliqué — le test échouait alors sans
 * qu'aucun code ne soit en cause.
 */
async function write(auth, docId, suffix, text) {
  const doc = new Y.Doc();
  doc.getText('content').insert(0, text);
  return json(`/api/documents/${docId}/updates`, {
    method: 'POST',
    headers: auth,
    body: JSON.stringify({
      opId: `op_${suffix}_${RUN}`,
      update: Buffer.from(Y.encodeStateAsUpdate(doc)).toString('base64'),
    }),
  });
}

async function readText(auth, docId) {
  const state = await json(`/api/documents/${docId}/state`, { headers: auth });
  const doc = new Y.Doc();
  if (state.body.state) Y.applyUpdate(doc, Uint8Array.from(atob(state.body.state), (c) => c.charCodeAt(0)));
  return doc.getText('content').toString();
}

// --- Preparation -----------------------------------------------------------
// Identifiant unique par exécution : le mode local persiste sur disque, donc
// une adresse fixe réutiliserait les crédits et les `opId` des passages
// précédents.
const RUN = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

const session = await json('/api/session', {
  method: 'POST',
  body: JSON.stringify({ name: 'Versions', email: `versions-${RUN}@exemple.cm` }),
});
const auth = { authorization: `Bearer ${session.body.token}` };

const created = await json('/api/documents', {
  method: 'POST',
  headers: auth,
  body: JSON.stringify({ title: 'Test versions' }),
});
const docId = created.body.id;
check('document créé', Boolean(docId), docId);

// 1. Premier contenu
await write(auth, docId, 'op_v1', 'version un');
await wait(400);
check('contenu initial écrit', (await readText(auth, docId)) === 'version un');

// 2. Liste vide avant enregistrement
const empty = await json(`/api/documents/${docId}/versions`, { headers: auth });
check('aucune version au départ', empty.body.versions.length === 0, `${empty.body.versions.length}`);

// 3. Enregistrement explicite
const saved = await json(`/api/documents/${docId}/versions`, {
  method: 'POST',
  headers: auth,
  body: JSON.stringify({}),
});
check('POST versions -> 201', saved.status === 201, `n=${saved.body.version ? saved.body.version.n : '?'}`);

const list = await json(`/api/documents/${docId}/versions`, { headers: auth });
check('la version apparaît dans la liste', list.body.versions.length === 1, `${list.body.versions.length} version(s)`);

const n = list.body.versions[0] ? list.body.versions[0].n : 0;
check('numéro de version cohérent', n > 0, `n=${n}`);

// 4. Modification après la version
await write(auth, docId, 'op_v2', ' plus de contenu');
await wait(400);
check(
  'contenu modifié',
  (await readText(auth, docId)).includes('plus de contenu'),
  JSON.stringify(await readText(auth, docId)),
);

// 5. Restauration
const restored = await json(`/api/documents/${docId}/versions/${n}/restore`, {
  method: 'POST',
  headers: auth,
  body: JSON.stringify({}),
});
check('restauration -> 200', restored.status === 200, `seq=${restored.body.seq}`);
await wait(900);

const text = await readText(auth, docId);
check(
  'texte restauré (sans duplication)',
  text === 'version un',
  JSON.stringify(text),
);

// 6. Le texte écrasé reste dans l'historique
const after = await json(`/api/documents/${docId}/versions`, { headers: auth });
check(
  'l’historique contient aussi le texte écrasé',
  after.body.versions.length >= 2,
  `${after.body.versions.length} version(s)`,
);

// 7. La restauration est gratuite.
// Seules les deux écritures sont facturées : « version un » (10) et
// « plus de contenu » (16), soit 26. La restauration, elle, n'ajoute rien.
const credit = await json('/api/me/credit', { headers: auth });
check(
  'crédit non débité par la restauration',
  credit.body.used === 26,
  `used=${credit.body.used} (attendu 26 = 10 + 16)`,
);

console.log(`\n=== ${ok} OK, ${ko} FAIL ===`);
process.exit(ko === 0 ? 0 : 1);
