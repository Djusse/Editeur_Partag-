/**
 * Reproduction du chemin menant à `BLOCKED` (donc à la page /bloque).
 *
 * Le point à prouver : il faut QUATRE refus distincts, et le crédit ne doit PAS
 * être exactement à zéro — sinon l'éditeur s'ouvre directement en lecture seule
 * et aucun envoi (donc aucun refus) n'est possible.
 *
 * Usage : serveur local sur le port 4000.
 */
import * as Y from 'yjs';

const API = 'http://localhost:4000';

async function json(path, options = {}) {
  const response = await fetch(API + path, {
    ...options,
    headers: { 'content-type': 'application/json', ...(options.headers ?? {}) },
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

function updateOf(text) {
  const doc = new Y.Doc();
  const updates = [];
  doc.on('update', (u) => updates.push(u));
  doc.getText('content').insert(0, text);
  const bytes = updates[updates.length - 1];
  return Buffer.from(bytes).toString('base64');
}

const email = `repro-${Date.now()}@exemple.cm`;

const session = await json('/api/session', {
  method: 'POST',
  body: JSON.stringify({ name: 'Repro', email }),
});
const token = session.body.token;
const auth = { authorization: `Bearer ${token}` };

const doc = await json('/api/documents', {
  method: 'POST',
  headers: auth,
  body: JSON.stringify({ title: 'Repro /bloque' }),
});
const docId = doc.body.id;

// On laisse volontairement 5 caractères : le crédit ne tombe pas à zéro, donc
// l'éditeur restera éditable au rechargement et l'utilisateur pourra réessayer.
await json(`/api/documents/${docId}/updates`, {
  method: 'POST',
  headers: auth,
  body: JSON.stringify({ opId: 'op_fill', update: updateOf('a'.repeat(9995)) }),
});

const afterFill = await json('/api/me/credit', { headers: auth });
console.log(`crédit restant après remplissage : ${afterFill.body.remaining}`);

// Quatre tentatives de 10 caractères, avec des `opId` DISTINCTS.
for (let attempt = 1; attempt <= 4; attempt++) {
  const result = await json(`/api/documents/${docId}/updates`, {
    method: 'POST',
    headers: auth,
    body: JSON.stringify({ opId: `op_refus_${attempt}`, update: updateOf('b'.repeat(10)) }),
  });
  console.log(
    `tentative ${attempt} -> HTTP ${result.status} code=${result.body.error ?? '-'} ` +
      `blockedUntil=${result.body.blockedUntil ?? '-'}`,
  );
}

const final = await json('/api/me/credit', { headers: auth });
console.log(`blockedUntil : ${final.body.blockedUntil ?? 'null'}`);

const debug = await json('/__debug');
const admin = await json('/api/admin/state', {
  headers: { 'x-admin-key': debug.body.adminKey },
});
console.log(
  `supervision -> ${admin.body.blocked.some((row) => row.email === email) ? 'PRÉSENT' : 'ABSENT'} dans « Personnes bloquées »`,
);
