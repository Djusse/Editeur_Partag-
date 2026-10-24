/**
 * Verification de bout en bout du mode local (aucun AWS).
 *
 * Couvre : session, document, etat, WebSocket natif, ecriture, idempotence,
 * credit, repli HTTP, lien, claim, PDF, echeance, admin, controle d'acces,
 * et le **preflight CORS** (le seul cas qu'un client Node ne voit pas).
 */
import * as Y from 'yjs';
import WebSocket from 'ws';

const API = 'http://localhost:4000';
// Origine du front en developpement : le navigateur l'envoie en `Origin`.
const FRONT_ORIGIN = process.env.FRONT_ORIGIN ?? 'http://localhost:3000';

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

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// 0. Preflight CORS — indispensable pour le navigateur en developpement.
// Un `fetch` Node ne fait pas de preflight : sans ce test, le bug reste invisible.
{
  const preflight = await fetch(`${API}/api/admin/state`, {
    method: 'OPTIONS',
    headers: {
      origin: FRONT_ORIGIN,
      'access-control-request-method': 'GET',
      'access-control-request-headers': 'x-admin-key',
    },
  });
  const allowOrigin = preflight.headers.get('access-control-allow-origin');
  const allowHeaders = preflight.headers.get('access-control-allow-headers') ?? '';
  check(
    'preflight CORS (OPTIONS) accepte',
    preflight.status === 204 || preflight.status === 200,
    `HTTP ${preflight.status}`,
  );
  check('en-tete Access-Control-Allow-Origin present', Boolean(allowOrigin), allowOrigin ?? 'absent');
  check(
    'x-admin-key autorise en CORS',
    allowHeaders.toLowerCase().includes('x-admin-key'),
    allowHeaders || 'absent',
  );

  // La reponse reelle doit aussi porter les en-tetes CORS.
  const real = await fetch(`${API}/api/config`, { headers: { origin: FRONT_ORIGIN } });
  check(
    'reponse reelle porte Access-Control-Allow-Origin',
    Boolean(real.headers.get('access-control-allow-origin')),
  );
}

// 1. Session
const session = await json('/api/session', {
  method: 'POST',
  body: JSON.stringify({ name: 'Awa', email: 'awa@exemple.cm' }),
});
check('POST /api/session -> token', session.status === 200 && Boolean(session.body.token));
const auth = { authorization: `Bearer ${session.body.token}` };

// 2. Creation
const doc = await json('/api/documents', {
  method: 'POST',
  headers: auth,
  body: JSON.stringify({ title: 'Journal 2026' }),
});
check('POST /api/documents -> id', doc.status === 201 && Boolean(doc.body.id), doc.body.id);
const docId = doc.body.id;

// 3. Etat initial
const state0 = await json(`/api/documents/${docId}/state`, { headers: auth });
check(
  'GET state -> seq 0 + etat',
  state0.status === 200 && state0.body.seq === 0 && typeof state0.body.state === 'string',
);

// 4. WebSocket natif
const ticket = await json('/api/ws-ticket', {
  method: 'POST',
  headers: auth,
  body: JSON.stringify({ documentId: docId }),
});
check('POST /api/ws-ticket -> ticket', ticket.status === 201 && Boolean(ticket.body.ticket));

const ws = new WebSocket(`ws://localhost:4000/ws?ticket=${ticket.body.ticket}&documentId=${docId}`);
const inbox = [];
await new Promise((resolve, reject) => {
  ws.on('open', resolve);
  ws.on('error', reject);
  setTimeout(() => reject(new Error('timeout ws')), 5000);
});
check('WebSocket connecte', ws.readyState === WebSocket.OPEN);

ws.on('message', (raw) => inbox.push(JSON.parse(raw.toString())));
ws.send(JSON.stringify({ type: 'join', documentId: docId, sinceSeq: 0 }));
await wait(300);
check('join -> message joined', inbox.some((m) => m.type === 'joined'));

// 5. Ecriture via WebSocket
const ydoc = new Y.Doc();
ydoc.getText('content').insert(0, 'Bonjour le journal');
const payload = Buffer.from(Y.encodeStateAsUpdate(ydoc)).toString('base64');
ws.send(JSON.stringify({ type: 'update', opId: 'op_ws_1', documentId: docId, payload }));
await wait(900);

const ack = inbox.find((m) => m.type === 'ack');
check(
  'ack {opIds, seq, creditRemaining}',
  Boolean(ack) && Array.isArray(ack.opIds) && ack.seq === 1,
  ack ? `seq=${ack.seq} restant=${ack.creditRemaining}` : 'aucun ack',
);
const diff = inbox.find((m) => m.type === 'update');
check('diffusion update (sans author)', Boolean(diff) && !('author' in diff));

// 6. Credit
const credit1 = await json('/api/me/credit', { headers: auth });
check(
  'GET /api/me/credit -> 18 utilises',
  credit1.body.used === 18 && credit1.body.remaining === 9982,
  `${credit1.body.used} utilises`,
);

// 7. Idempotence : meme opId
ws.send(JSON.stringify({ type: 'update', opId: 'op_ws_1', documentId: docId, payload }));
await wait(700);
const state1 = await json(`/api/documents/${docId}/state`, { headers: auth });
const credit2 = await json('/api/me/credit', { headers: auth });
check(
  'retry meme opId -> pas de double debit',
  credit2.body.used === 18 && state1.body.seq === 1,
  `used=${credit2.body.used} seq=${state1.body.seq}`,
);

// 8. Repli HTTP
const httpDoc = new Y.Doc();
httpDoc.getText('content').insert(0, ' via HTTP');
const httpResult = await json(`/api/documents/${docId}/updates`, {
  method: 'POST',
  headers: auth,
  body: JSON.stringify({
    opId: 'op_http_1',
    update: Buffer.from(Y.encodeStateAsUpdate(httpDoc)).toString('base64'),
  }),
});
check(
  'repli HTTP -> ack',
  httpResult.status === 200 && httpResult.body.ack.opIds.includes('op_http_1'),
  `seq=${httpResult.body.ack ? httpResult.body.ack.seq : '?'}`,
);

// 9. Lien + claim + PDF
const link = await json(`/api/documents/${docId}/links`, {
  method: 'POST',
  headers: auth,
  body: JSON.stringify({ maxDownloads: 2 }),
});
check(
  'POST links -> 201',
  link.status === 201,
  `token=${link.body.token ? link.body.token.slice(0, 8) : '?'}...`,
);
const token = link.body.token;

const claim = (visitorId) =>
  json(`/d/${token}/claim`, { method: 'POST', body: JSON.stringify({ visitorId }) });

const claim1 = await claim('visiteur_1_abcdef');
check('claim #1 -> 202 waiting', claim1.status === 202 && claim1.body.state === 'waiting');

await wait(1800);
let file = await json(`/d/${token}/file?visitorId=visiteur_1_abcdef`);
if (file.status === 202) {
  await wait(2500);
  file = await json(`/d/${token}/file?visitorId=visiteur_1_abcdef`);
}
check('file -> PDF pret', file.status === 200 && file.body.state === 'ready', file.body.url);

if (file.body.url) {
  const pdf = await fetch(API + file.body.url);
  const buffer = Buffer.from(await pdf.arrayBuffer());
  check('PDF valide et telechargeable', buffer.subarray(0, 5).toString() === '%PDF-', `${buffer.length} octets`);
}

await claim('visiteur_2_abcdef');
await wait(600);
const claim3 = await claim('visiteur_3_abcdef');
check('claim #3 -> 410 epuise', claim3.status === 410 && claim3.body.state === 'exhausted');

const again = await claim('visiteur_1_abcdef');
check('retry visiteur #1 -> jamais 410', again.status !== 410, `etat=${again.body.state}`);

// 10. Status public
const status = await json(`/d/${token}/status`);
check(
  'GET status -> exhausted + title',
  status.body.status === 'exhausted' && status.body.title === 'Journal 2026',
);

// 11. Admin
const debug = await json('/__debug');
const admin = await json('/api/admin/state', { headers: { 'x-admin-key': debug.body.adminKey } });
check(
  'GET /api/admin/state -> 3 blocs',
  admin.status === 200 &&
    Array.isArray(admin.body.openDocuments) &&
    Array.isArray(admin.body.activeLinks) &&
    Array.isArray(admin.body.blocked),
  `${admin.body.openDocuments ? admin.body.openDocuments.length : '?'} doc ouvert(s)`,
);

// 12. Controle d'acces
const noAuth = await json('/api/documents');
check('GET /api/documents sans JWT -> 401', noAuth.status === 401);

ws.close();
console.log(`\n=== ${ok} OK, ${ko} FAIL ===`);
process.exit(ko === 0 ? 0 : 1);
