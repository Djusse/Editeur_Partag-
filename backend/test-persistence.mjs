/**
 * Verifie que le mode local survit a un redemarrage :
 * documents, texte, liens, sessions (secret JWT) et cle d'administration.
 *
 * Le script redemarre lui-meme le serveur entre les deux phases.
 */
import { execSync, spawn } from 'node:child_process';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import * as Y from 'yjs';

const API = 'http://localhost:4000';
// `URL.pathname` laisse les caractères non ASCII encodés (`%C3%A9` pour « é »),
// ce qui casse le `cwd` du processus enfant. `fileURLToPath` décode correctement.
const ROOT = fileURLToPath(new URL('.', import.meta.url));
const DATA = fileURLToPath(new URL('.local-data.json', import.meta.url));
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

function stopServer() {
  try {
    execSync("PID=$(ss -lptnH 'sport = :4000' | grep -oP 'pid=\\K[0-9]+' | head -1); [ -n \"$PID\" ] && kill $PID", {
      shell: '/bin/bash',
    });
  } catch {
    /* déjà arrêté */
  }
}

async function startServer() {
  // `npm` n'est pas toujours dans le PATH d'un processus lancé par Node :
  // on passe par le binaire local de `tsx`, qui est déjà résolu.
  const { createRequire } = await import('node:module');
  const require = createRequire(import.meta.url);
  const tsx = require.resolve('tsx/cli');
  const child = spawn(process.execPath, [tsx, 'src/local/main.ts'], {
    cwd: ROOT,
    detached: true,
    stdio: 'ignore',
    env: process.env,
  });
  child.unref();

  for (let attempt = 0; attempt < 40; attempt++) {
    await wait(500);
    try {
      const response = await fetch(`${API}/health`);
      if (response.ok) return;
    } catch {
      /* pas encore prêt */
    }
  }
  throw new Error('Le serveur local ne répond pas');
}

// --- Phase 1 : créer des données ------------------------------------------
stopServer();
await wait(1500);
if (existsSync(DATA)) rmSync(DATA);
await startServer();

const session = await json('/api/session', {
  method: 'POST',
  body: JSON.stringify({ name: 'Persist', email: 'persist@exemple.cm' }),
});
const auth = { authorization: `Bearer ${session.body.token}` };

const doc = await json('/api/documents', {
  method: 'POST',
  headers: auth,
  body: JSON.stringify({ title: 'Test persistance' }),
});
const docId = doc.body.id;

const link = await json(`/api/documents/${docId}/links`, {
  method: 'POST',
  headers: auth,
  body: JSON.stringify({ maxDownloads: 3 }),
});
const token = link.body.token;

const ydoc = new Y.Doc();
ydoc.getText('content').insert(0, 'texte qui doit survivre');
const update = Buffer.from(Y.encodeStateAsUpdate(ydoc)).toString('base64');

await json(`/api/documents/${docId}/updates`, {
  method: 'POST',
  headers: auth,
  body: JSON.stringify({ opId: 'op_persist_1', update }),
});

const debug1 = await json('/__debug');
const adminKey = debug1.body.adminKey;

check('données créées', Boolean(docId && token && adminKey), `doc=${docId}`);
await wait(1500); // laisse le debounce écrire le fichier
check('fichier de persistance écrit', existsSync(DATA), `${readFileSync(DATA, 'utf8').length} octets`);

// --- Phase 2 : redémarrer --------------------------------------------------
stopServer();
await wait(2500);
await startServer();

const debug2 = await json('/__debug');
check(
  'clé d’administration conservée',
  debug2.body.adminKey === adminKey,
  `${adminKey.slice(0, 10)}…`,
);

const login = await json(`/api/documents/${docId}`, { headers: auth });
check('session encore valide (même secret JWT)', login.status === 200, `HTTP ${login.status}`);
check('document restauré', login.body.title === 'Test persistance', login.body.title ?? '');

const status = await json(`/d/${token}/status`);
check(
  'lien encore valide',
  status.body.status === 'active' && status.body.remaining === 3,
  `remaining=${status.body.remaining}`,
);

const state = await json(`/api/documents/${docId}/state`, { headers: auth });
const restored = new Y.Doc();
Y.applyUpdate(restored, Uint8Array.from(atob(state.body.state), (char) => char.charCodeAt(0)));
check(
  'texte du document restauré',
  restored.getText('content').toString() === 'texte qui doit survivre',
  JSON.stringify(restored.getText('content').toString()),
);

console.log(`\n=== ${ok} OK, ${ko} FAIL ===`);
process.exit(ko === 0 ? 0 : 1);
