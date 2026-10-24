import * as Y from 'yjs';

const API = 'http://localhost:4000';
let ok = 0, ko = 0;
const check = (label, cond, extra = '') => {
  if (cond) { console.log(`  OK   ${label}${extra ? ' — ' + extra : ''}`); ok++; }
  else { console.log(`  FAIL ${label}${extra ? ' — ' + extra : ''}`); ko++; }
};
const json = async (path, opts = {}) => {
  const r = await fetch(API + path, { ...opts, headers: { 'content-type': 'application/json', ...(opts.headers || {}) } });
  const t = await r.text();
  let b = {}; try { b = JSON.parse(t); } catch {}
  return { status: r.status, body: b };
};

// 1. Session
const s = await json('/session', { method: 'POST', body: JSON.stringify({ name: 'Awa', email: 'awa@exemple.cm' }) });
check('POST /session → 200 + JWT', s.status === 200 && typeof s.body.token === 'string');
const auth = { authorization: `Bearer ${s.body.token}` };

// 2. Création document
const d = await json('/documents', { method: 'POST', body: JSON.stringify({ title: 'Journal 2026' }), headers: auth });
check('POST /documents → 201', d.status === 201, d.body?.document?.docId);
const docId = d.body.document.docId;

// 3. Écriture (update Yjs réel via repli HTTP)
const ydoc = new Y.Doc();
const updates = [];
ydoc.on('update', u => updates.push(u));
ydoc.getText('content').insert(0, 'Bonjour le journal');
const up = Y.encodeStateAsUpdate(ydoc);
const w = await json(`/documents/${docId}/updates`, {
  method: 'POST', headers: auth,
  body: JSON.stringify({ opId: 'op_1', update: Buffer.from(up).toString('base64') })
});
check('POST updates → ack seq=1', w.status === 200 && w.body.ack?.seq === 1, `chars=${w.body.ack?.chars}`);

// 4. Idempotence : même opId
const w2 = await json(`/documents/${docId}/updates`, {
  method: 'POST', headers: auth,
  body: JSON.stringify({ opId: 'op_1', update: Buffer.from(up).toString('base64') })
});
check('retry même opId → duplicate, même seq', w2.body.ack?.duplicate === true && w2.body.ack?.seq === 1);

// 5. Crédit
const c = await json('/me/credit', { headers: auth });
check('GET /me/credit → 10 000 - 18', c.body.used === 18 && c.body.remaining === 9982, `${c.body.used} utilisés`);

// 6. État reconstruit
const st = await json(`/documents/${docId}/state`, { headers: auth });
const rebuilt = new Y.Doc();
if (st.body.snapshot) Y.applyUpdate(rebuilt, Buffer.from(st.body.snapshot, 'base64'));
for (const u of st.body.updates) Y.applyUpdate(rebuilt, Buffer.from(u.payload, 'base64'));
check('état reconstruit = texte écrit', rebuilt.getText('content').toString() === 'Bonjour le journal', JSON.stringify(rebuilt.getText('content').toString()));

// 7. Lien + claim
const l = await json(`/documents/${docId}/links`, { method: 'POST', headers: auth, body: JSON.stringify({ maxDownloads: 2 }) });
check('POST links → 201', l.status === 201, `token=${l.body.link?.token?.slice(0, 8)}…`);
const token = l.body.link.token;

const claim = (vid) => json(`/d/${token}/claim`, { method: 'POST', body: JSON.stringify({ visitorId: vid }) });
const c1 = await claim('visiteur_1_abcdef');
check('claim #1 → 202 waiting (PDF en génération)', c1.status === 202 || c1.status === 200, `state=${c1.body.state}`);

// Attente de la génération PDF puis polling
await new Promise(r => setTimeout(r, 1500));
let file = await json(`/d/${token}/file?visitorId=visiteur_1_abcdef`);
if (file.status === 202) { await new Promise(r => setTimeout(r, 2000)); file = await json(`/d/${token}/file?visitorId=visiteur_1_abcdef`); }
check('GET /d/{token}/file → PDF prêt', file.status === 200 && typeof file.body.url === 'string', file.body.url?.slice(0, 48));

// Téléchargement réel du PDF
if (file.body.url) {
  const pdf = await fetch(file.body.url);
  const buf = Buffer.from(await pdf.arrayBuffer());
  check('PDF téléchargeable et valide', pdf.status === 200 && buf.subarray(0, 5).toString() === '%PDF-', `${buf.length} octets`);
}

const c2 = await claim('visiteur_2_abcdef');
await new Promise(r => setTimeout(r, 800));
const c3 = await claim('visiteur_3_abcdef');
check('claim #3 → 410 exhausted', c3.status === 410, `state=${c3.body.state}`);
const again = await claim('visiteur_1_abcdef');
check('retry visiteur #1 après épuisement → même ticket', again.status !== 410, `state=${again.body.state}`);

// 8. Statut public
const stat = await json(`/d/${token}/status`);
check('GET status → exhausted / remaining 0', stat.body.status === 'exhausted' && stat.body.remaining === 0);

// 9. Versions
const v = await json(`/documents/${docId}/versions`, { method: 'POST', headers: auth, body: '{}' });
check('POST versions → 201', v.status === 201, `n=${v.body.version?.n}`);
const vl = await json(`/documents/${docId}/versions`, { headers: auth });
check('GET versions → liste', Array.isArray(vl.body.versions), `${vl.body.versions?.length} version(s)`);

// 10. Admin
const dbg = await json('/__debug');
const adm = await json('/admin/state', { headers: { 'x-admin-key': dbg.body.adminKey } });
check('GET /admin/state avec clé → 200', adm.status === 200, `liens actifs=${adm.body.activeLinks}`);

// 11. Sécurité : sans JWT
const noAuth = await json('/documents');
check('GET /documents sans JWT → 401', noAuth.status === 401);

console.log(`\n=== ${ok} OK, ${ko} FAIL ===`);
process.exit(ko === 0 ? 0 : 1);
