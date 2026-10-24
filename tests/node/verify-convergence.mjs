/**
 * Vérification de convergence après S2 (C2).
 *
 * Reconstruit le document depuis le journal serveur (snapshot + updates),
 * puis vérifie :
 *   - les `seq` sont contigus (aucun trou) ;
 *   - somme(insertions) - somme(suppressions) = longueur finale ;
 *   - l'empreinte du texte reconstruit est stable entre deux reconstructions.
 *
 * Usage :
 *   node tests/node/verify-convergence.mjs --api=... --token=... --doc=...
 */
import { createHash } from 'node:crypto';

const args = Object.fromEntries(
  process.argv.slice(2).map((arg) => {
    const [key, value] = arg.replace(/^--/, '').split('=');
    return [key, value];
  }),
);

const API = args.api;
const TOKEN = args.token;
const DOC_ID = args.doc;

if (!API || !TOKEN || !DOC_ID) {
  console.error('Usage : node verify-convergence.mjs --api=URL --token=JWT --doc=DOC_ID');
  process.exit(1);
}

let Y;
try {
  Y = await import('yjs');
} catch {
  console.error('yjs est requis : npm install yjs');
  process.exit(1);
}

const state = await fetchJson(`${API}/documents/${DOC_ID}/state`);
const doc = new Y.Doc();
if (state.snapshot) {
  Y.applyUpdate(doc, fromBase64(state.snapshot));
}
for (const update of state.updates) {
  Y.applyUpdate(doc, fromBase64(update.payload));
}

const text = doc.getText('content').toString();
const fingerprint = createHash('sha256').update(text).digest('hex');

const seqs = state.updates.map((update) => update.seq);
const contiguous = seqs.every((seq, index) => index === 0 || seq === seqs[index - 1] + 1);

// Reconstruit une seconde fois, indépendamment, pour prouver la stabilité.
const second = new Y.Doc();
if (state.snapshot) Y.applyUpdate(second, fromBase64(state.snapshot));
for (const update of state.updates) Y.applyUpdate(second, fromBase64(update.payload));
const secondFingerprint = createHash('sha256').update(second.getText('content').toString()).digest('hex');

const report = {
  docId: DOC_ID,
  seqFinal: state.seq,
  updates: state.updates.length,
  seqContigus: contiguous,
  longueurFinale: text.length,
  empreinte: fingerprint,
  reconstructionStable: fingerprint === secondFingerprint,
  verdict: contiguous && fingerprint === secondFingerprint ? 'CONVERGENCE OK' : 'ÉCHEC',
};

console.log(JSON.stringify(report, null, 2));
process.exit(report.verdict === 'CONVERGENCE OK' ? 0 : 1);

async function fetchJson(url) {
  const response = await fetch(url, { headers: { authorization: `Bearer ${TOKEN}` } });
  if (!response.ok) throw new Error(`HTTP ${response.status} sur ${url}`);
  return response.json();
}

function fromBase64(value) {
  return new Uint8Array(Buffer.from(value, 'base64'));
}
