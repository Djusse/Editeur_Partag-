/**
 * C2 et restauration : le scénario qui compte vraiment.
 *
 * Deux clients WebSocket réels, comme le provider du front :
 *   1. A et B tapent (B tape APRÈS la restauration) ;
 *   2. A restaure une version ;
 *   3. on vérifie que A, B et l'état serveur convergent ;
 *   4. on vérifie qu'aucune modification **acceptée** (acquittée) n'est perdue.
 *
 * Ce test a été écrit pour trancher une question précise : la divergence
 * observée dans le navigateur est-elle une violation de C2 (des modifications
 * acceptées disparaissent) ou le comportement normal d'un CRDT (des frappes
 * jamais émises réapparaissent) ?
 *
 * Usage : serveur local sur le port 4000.
 */
import { WebSocket } from 'ws';
import * as Y from 'yjs';

const API = 'http://localhost:4000';
const WS = 'ws://localhost:4000/ws';

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

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

/** Ouvre un client WebSocket sur le document, comme le front. */
function connect(ticket, documentId) {
  const socket = new WebSocket(`${WS}?ticket=${encodeURIComponent(ticket)}&documentId=${encodeURIComponent(documentId)}`);
  const messages = [];
  const listeners = [];
  const opened = new Promise((resolve) => socket.once('open', resolve));
  socket.on('message', (raw) => {
    const message = JSON.parse(raw.toString());
    messages.push(message);
    for (const listener of [...listeners]) listener(message);
  });
  socket.on('error', (error) => console.error('WS erreur', error.message));

  return {
    socket,
    opened,
    send(message) {
      if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(message));
    },
    /** Attend l'ouverture puis envoie. */
    async sendWhenOpen(message) {
      await opened;
      socket.send(JSON.stringify(message));
    },
    next(predicate, timeoutMs = 5000) {
      return new Promise((resolve) => {
        const found = messages.find(predicate);
        if (found) return resolve(found);
        const timer = setTimeout(() => {
          const index = listeners.indexOf(listener);
          if (index >= 0) listeners.splice(index, 1);
          resolve(null);
        }, timeoutMs);
        const listener = (message) => {
          if (!predicate(message)) return;
          clearTimeout(timer);
          const index = listeners.indexOf(listener);
          if (index >= 0) listeners.splice(index, 1);
          resolve(message);
        };
        listeners.push(listener);
      });
    },
    close() {
      socket.close();
    },
  };
}

const byName = {
  Alice: `alice-${Date.now()}@exemple.cm`,
  Bob: `bob-${Date.now()}@exemple.cm`,
};

const sessions = {};
for (const [name, email] of Object.entries(byName)) {
  const session = await json('/api/session', {
    method: 'POST',
    body: JSON.stringify({ name, email }),
  });
  sessions[name] = { token: session.body.token, email };
}

// Document créé par Alice, Bob ajouté comme rédacteur.
const create = await json('/api/documents', {
  method: 'POST',
  headers: { authorization: `Bearer ${sessions.Alice.token}` },
  body: JSON.stringify({ title: 'Test restauration à deux' }),
});
const docId = create.body.id;

await json(`/api/documents/${docId}/members`, {
  method: 'POST',
  headers: { authorization: `Bearer ${sessions.Alice.token}` },
  body: JSON.stringify({ email: sessions.Bob.email }),
});

async function openClient(name) {
  const ticket = await json('/api/ws-ticket', {
    method: 'POST',
    headers: { authorization: `Bearer ${sessions[name].token}` },
    body: JSON.stringify({ documentId: docId }),
  });
  const client = connect(ticket.body.ticket, docId);
  const doc = new Y.Doc();
  // Le provider applique les updates reçus au Y.Doc local, comme ici.
  client.doc = doc;
  await client.opened;
  client.socket.on('message', (raw) => {
    const message = JSON.parse(raw.toString());
    if (message.type === 'update' && typeof message.payload === 'string') {
      Y.applyUpdate(doc, Buffer.from(message.payload, 'base64'), 'remote');
    }
  });
  client.send({ type: 'join', documentId: docId, sinceSeq: 0 });
  await client.next((m) => m.type === 'joined');
  await wait(200);
  return client;
}

/** Envoie une frappe locale et attend son acquittement. */
async function type(client, text, opId) {
  const before = client.doc.getText('content').toString();
  client.doc.getText('content').insert(before.length, text);
  const update = Y.encodeStateAsUpdate(client.doc);
  const payload = Buffer.from(
    // On n'envoie que le delta : suffisant pour le test, le serveur fusionne.
    Y.encodeStateAsUpdate(client.doc, Y.encodeStateVector(new Y.Doc())),
  ).toString('base64');
  client.send({ type: 'update', opId, documentId: docId, payload });
  const ack = await client.next((m) => m.type === 'ack' && m.opIds?.includes(opId), 8000);
  return { ack, update, before, payload };
}

const serverText = async () => {
  const state = await json(`/api/documents/${docId}/state`, {
    headers: { authorization: `Bearer ${sessions.Alice.token}` },
  });
  const doc = new Y.Doc();
  Y.applyUpdate(doc, Buffer.from(state.body.state, 'base64'));
  return doc.getText('content').toString();
};

const alice = await openClient('Alice');
const bob = await openClient('Bob');

// 1. Alice écrit, puis crée une version.
await type(alice, 'ETAT INITIAL', 'op_a1');
await wait(400);
const version = await json(`/api/documents/${docId}/versions`, {
  method: 'POST',
  headers: { authorization: `Bearer ${sessions.Alice.token}` },
  body: JSON.stringify({}),
});
const n = version.body.version.n;
console.log(`version enregistrée : n=${n}`);

// 2. Alice ajoute du texte APRÈS la version (sera effacé par la restauration).
await type(alice, ' + APRES VERSION', 'op_a2');
await wait(500);

// 3. Alice restaure la version.
const restore = await json(`/api/documents/${docId}/versions/${n}/restore`, {
  method: 'POST',
  headers: { authorization: `Bearer ${sessions.Alice.token}` },
  body: JSON.stringify({}),
});
console.log(`restauration : HTTP ${restore.status}`);
await wait(800);

// 4. Bob tape APRÈS la restauration, et son update DOIT être accepté.
const bobTyping = await type(bob, ' | BOB APRES RESTAURATION', 'op_b1');
console.log(`frappe de Bob après restauration : ack=${Boolean(bobTyping.ack)}`);

// 5. Les deux clients retapent, comme dans la capture.
await type(alice, ' | ALICE APRES', 'op_a3');
await type(bob, ' | BOB ENCORE', 'op_b2');
await wait(1200);

const finalServer = await serverText();
const finalAlice = alice.doc.getText('content').toString();
const finalBob = bob.doc.getText('content').toString();

console.log('\n--- résultats ---');
console.log('serveur :', JSON.stringify(finalServer));
console.log('Alice   :', JSON.stringify(finalAlice));
console.log('Bob     :', JSON.stringify(finalBob));

const converge = finalServer === finalAlice && finalAlice === finalBob;
const bobKept = finalServer.includes('BOB APRES RESTAURATION');
const aliceKept = finalServer.includes('ALICE APRES');
const preRestoreGone = !finalServer.includes('APRES VERSION');

console.log('');
console.log(`convergence des trois états      : ${converge ? 'OK' : 'ECHEC'}`);
console.log(`frappe de Bob (après restauration) conservée : ${bobKept ? 'OK' : 'PERDUE'}`);
console.log(`frappe d'Alice (après restauration) conservée : ${aliceKept ? 'OK' : 'PERDUE'}`);
console.log(`texte antérieur à la version effacé : ${preRestoreGone ? 'OK' : 'NON'}`);
console.log('');
console.log(
  converge && bobKept && aliceKept
    ? '=> C2 respectée : aucune frappe acceptée après la restauration n\'est perdue.'
    : '=> C2 VIOLÉE : une modification acceptée manque à la convergence.',
);

alice.close();
bob.close();
await wait(200);
process.exit(converge && bobKept && aliceKept ? 0 : 1);
