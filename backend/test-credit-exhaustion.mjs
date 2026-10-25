/**
 * Vérifie le scénario d'épuisement de crédit (sections 9.4 à 9.6, contrainte C4).
 *
 * Ce que l'on prouve, dans l'ordre :
 *  1. le crédit se décompte exactement, jusqu'à zéro ;
 *  2. à zéro, le moindre update est refusé avec `CREDIT_EXHAUSTED` et
 *     `creditRemaining = 0` — la jauge peut donc se mettre à jour ;
 *  3. un update refusé n'est **pas** journalisé : il reste invisible aux autres ;
 *  4. à la reconnexion, `joined` annonce `readOnly` et le crédit restant, sinon
 *     la jauge afficherait encore « 1 / 10 000 » ;
 *  5. les refus répétés finissent par bloquer (`BLOCKED`) avec `blockedUntil`.
 *
 * Le test consomme tout le plafond du jour : il utilise donc une adresse
 * dédiée et unique. Le plafond (10 000) est le double de `CREDIT_LIMIT` utilisé
 * par les tests unitaires : on le relit depuis `GET /me/credit`.
 *
 * Usage : serveur local démarré sur le port 4000.
 */
import { WebSocket } from 'ws';
import * as Y from 'yjs';

const API = 'http://localhost:4000';
const WS = 'ws://localhost:4000/ws';

let ok = 0;
let ko = 0;
const check = (label, cond, extra = '') => {
  if (cond) {
    console.log(`  OK   ${label}${extra ? ` - ${extra}` : ''}`);
    ok++;
  } else {
    console.log(`  FAIL ${label}${extra ? ` - ${extra}` : ''}`);
    ko++;
  }
};

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

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

/** Ouvre un WebSocket et collecte les messages ; `next` attend un prédicat. */
function connect(ticket, documentId) {
  const socket = new WebSocket(
    `${WS}?ticket=${encodeURIComponent(ticket)}&documentId=${encodeURIComponent(documentId)}`,
  );
  const messages = [];
  const listeners = [];

  socket.on('message', (raw) => {
    let message;
    try {
      message = JSON.parse(raw.toString('utf8'));
    } catch {
      return;
    }
    messages.push(message);
    for (const listener of [...listeners]) listener(message);
  });

  return {
    opened: new Promise((resolve, reject) => {
      socket.once('open', resolve);
      socket.once('error', reject);
    }),
    send: (payload) => socket.send(JSON.stringify(payload)),
    /** Attend un message satisfaisant `predicate` ; `null` si délai dépassé. */
    next(predicate, timeoutMs = 8000) {
      const existing = messages.find(predicate);
      if (existing) return Promise.resolve(existing);
      return new Promise((resolve) => {
        const drop = () => {
          const index = listeners.indexOf(listener);
          if (index >= 0) listeners.splice(index, 1);
        };
        const timer = setTimeout(() => {
          drop();
          resolve(null);
        }, timeoutMs);
        const listener = (message) => {
          if (!predicate(message)) return;
          clearTimeout(timer);
          drop();
          resolve(message);
        };
        listeners.push(listener);
      });
    },
    close: () => socket.close(),
  };
}

/** Update Yjs insérant `length` caractères. */
function makeUpdate(length, index = 0) {
  const doc = new Y.Doc();
  doc.getText('content').insert(index, 'a'.repeat(length));
  return Buffer.from(Y.encodeStateAsUpdate(doc)).toString('base64');
}

console.log('\n=== Épuisement du crédit (C4, sections 9.4 à 9.6) ===\n');

// --- Préparation ----------------------------------------------------------
const email = `credit-test-${Date.now()}@exemple.cm`;
const session = await json('/api/session', {
  method: 'POST',
  body: JSON.stringify({ name: 'Test crédit', email }),
});
check('session créée', session.status === 200, email);
const token = session.body.token;
const auth = { authorization: `Bearer ${token}` };
const limit = session.body.credit.limit;
check('plafond lu depuis l’API', limit > 0, `limit=${limit}`);

const doc = await json('/api/documents', {
  method: 'POST',
  headers: auth,
  body: JSON.stringify({ title: 'Test épuisement crédit' }),
});
const docId = doc.body.id;
check('document créé', doc.status === 201, docId);

async function openClient(withJoin = true) {
  const ticket = await json('/api/ws-ticket', {
    method: 'POST',
    headers: auth,
    body: JSON.stringify({ documentId: docId }),
  });
  const client = connect(ticket.body.ticket, docId);
  await client.opened;
  const joined = await client.next((m) => m.type === 'joined');
  if (withJoin) {
    client.send({ type: 'join', sinceSeq: 0 });
    await client.next((m) => m.type === 'joined' && m.caughtUp !== undefined);
  }
  return { client, joined };
}

// --- 1. Consommer exactement tout le crédit ------------------------------
const first = await openClient();
check(
  'joined porte creditRemaining',
  typeof first.joined?.creditRemaining === 'number',
  `creditRemaining=${first.joined?.creditRemaining}`,
);
check('joined n’annonce pas la lecture seule', first.joined?.readOnly === undefined);

// Un seul update de `limit` caractères : le crédit tombe exactement à zéro.
first.client.send({ type: 'update', opId: 'op_fill', payload: makeUpdate(limit) });
const ack = await first.client.next((m) => m.type === 'ack' && Array.isArray(m.opIds));
check('update accepté', Boolean(ack), ack ? `seq=${ack.seq}` : 'aucun ack');
check('crédit épuisé après l’update', ack?.creditRemaining === 0, `creditRemaining=${ack?.creditRemaining}`);

const credit = await json('/api/me/credit', { headers: auth });
check('GET /me/credit : remaining = 0', credit.body.remaining === 0, `remaining=${credit.body.remaining}`);
check(
  'resetsAt fourni (minuit heure de Douala)',
  typeof credit.body.resetsAt === 'string' && new Date(credit.body.resetsAt).getUTCHours() === 23,
  credit.body.resetsAt,
);

const seqBefore = (await json(`/api/documents/${docId}/state`, { headers: auth })).body.seq;

// --- 2. À zéro, le moindre update est refusé -----------------------------
first.client.send({ type: 'update', opId: 'op_one_char', payload: makeUpdate(1, limit) });
const refusal = await first.client.next((m) => m.type === 'error');
check('update d’un caractère refusé', refusal?.code === 'CREDIT_EXHAUSTED', `code=${refusal?.code}`);
check(
  'le refus annonce creditRemaining = 0',
  refusal?.creditRemaining === 0,
  `creditRemaining=${refusal?.creditRemaining}`,
);

// --- 3. L'update refusé n'est pas journalisé -----------------------------
const state = await json(`/api/documents/${docId}/state`, { headers: auth });
const ydoc = new Y.Doc();
Y.applyUpdate(ydoc, Uint8Array.from(atob(state.body.state), (c) => c.charCodeAt(0)));
check(
  'le texte refusé est absent de l’état serveur',
  ydoc.getText('content').toString().length === limit,
  `${ydoc.getText('content').toString().length} caractères (attendu ${limit})`,
);
check('la séquence n’a pas avancé', state.body.seq === seqBefore, `seq=${state.body.seq}`);

first.client.close();
await wait(300);

// --- 4. À la reconnexion, l'état de lecture seule est annoncé ------------
const second = await openClient();
check(
  'la reconnexion annonce CREDIT_EXHAUSTED',
  second.joined?.readOnly === 'CREDIT_EXHAUSTED',
  `readOnly=${second.joined?.readOnly}`,
);
check(
  'la reconnexion annonce creditRemaining = 0',
  second.joined?.creditRemaining === 0,
  `creditRemaining=${second.joined?.creditRemaining}`,
);

// --- 5. Un envoi malgré la lecture seule reste refusé --------------------
second.client.send({ type: 'update', opId: 'op_after_exhausted', payload: makeUpdate(1, limit) });
const refusal2 = await second.client.next((m) => m.type === 'error');
check('un envoi après épuisement est encore refusé', refusal2?.code === 'CREDIT_EXHAUSTED', `code=${refusal2?.code}`);

// --- 6. Les refus répétés finissent par bloquer (C4) ---------------------
// `blockAfterRefusals` vaut 4 : on envoie des `opId` distincts pour être compté.
let blocked = null;
for (let attempt = 0; attempt < 8 && !blocked; attempt++) {
  second.client.send({ type: 'update', opId: `op_refusal_${attempt}`, payload: makeUpdate(1, limit) });
  const message = await second.client.next(
    (m) => m.type === 'error' && m.opId === `op_refusal_${attempt}`,
    4000,
  );
  if (message?.code === 'BLOCKED') blocked = message;
}
check('blocage après refus répétés', blocked?.code === 'BLOCKED', `code=${blocked?.code ?? 'aucun'}`);
check(
  'le blocage annonce blockedUntil',
  typeof blocked?.blockedUntil === 'string',
  blocked?.blockedUntil ?? '',
);

second.client.close();
await wait(200);

// --- 7. Bloqué, l'ouverture l'annonce aussi ------------------------------
const third = await openClient(false);
check(
  'la reconnexion annonce BLOCKED',
  third.joined?.readOnly === 'BLOCKED',
  `readOnly=${third.joined?.readOnly}`,
);
third.client.close();

console.log(`\n=== ${ok} OK, ${ko} FAIL ===\n`);
process.exit(ko === 0 ? 0 : 1);
