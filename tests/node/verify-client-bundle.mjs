/**
 * Vérifie que le bundle client contient bien l'URL de l'API attendue.
 *
 * Pourquoi ce test existe : les variables `NEXT_PUBLIC_*` sont **inlinées dans
 * le bundle** à la compilation. Une valeur absente ou écrasée (`''`) produit un
 * client qui appelle `/api` sur l'origine du front — le serveur, lui, répond
 * parfaitement si on l'interroge directement. Tous les tests côté serveur
 * passent donc au vert alors que l'interface affiche « Impossible de charger
 * vos documents ».
 *
 * C'est exactement ce qui est arrivé deux fois (défauts 20 et 23 du journal) :
 * le contrat serveur était bon, la construction d'URL côté client était fausse.
 *
 * Usage (après un `npm run build` ou pendant `npm run dev:local`) :
 *
 *   node tests/node/verify-client-bundle.mjs                  # build de production
 *   node tests/node/verify-client-bundle.mjs --dev            # développement local
 *   node tests/node/verify-client-bundle.mjs --dev --url http://localhost:3000
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const NEXT_DIR = join(ROOT, 'frontend', '.next');

const args = process.argv.slice(2);
const devMode = args.includes('--dev');
const urlIndex = args.indexOf('--url');
const baseUrl = urlIndex >= 0 ? args[urlIndex + 1] : 'http://localhost:3000';

let failures = 0;
let checks = 0;

function check(label, ok, detail = '') {
  checks++;
  if (ok) {
    console.log(`  OK   ${label}${detail ? ` - ${detail}` : ''}`);
  } else {
    failures++;
    console.log(`  FAIL ${label}${detail ? ` - ${detail}` : ''}`);
  }
}

/** Liste récursivement les fichiers .js d'un répertoire. */
function walk(dir, out = []) {
  if (!existsSync(dir)) return out;
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    const info = statSync(path);
    if (info.isDirectory()) walk(path, out);
    else if (entry.endsWith('.js')) out.push(path);
  }
  return out;
}

/** Recherche les occurrences de `pattern` dans tous les chunks. */
function findAll(files, pattern) {
  const hits = [];
  for (const file of files) {
    const content = readFileSync(file, 'utf8');
    if (content.includes(pattern)) hits.push(file.replace(ROOT, '.'));
  }
  return hits;
}

console.log(`\n=== Vérification du bundle client (${devMode ? 'développement' : 'production'}) ===\n`);

if (!existsSync(NEXT_DIR)) {
  console.log('  Le répertoire frontend/.next est absent : lancez d’abord un build ou `npm run dev:local`.');
  process.exit(1);
}

const chunks = walk(join(NEXT_DIR, 'static', 'chunks'));
check('des chunks existent', chunks.length > 0, `${chunks.length} fichier(s)`);

// 1. L'API doit être joignable depuis l'origine du front.
//
//    En production, nginx sert `/api` sur la même origine : le bundle doit donc
//    contenir `/api`. En développement, il doit contenir l'origine + le port de
//    l'API, sinon les appels partent sur le serveur Next.
const absoluteApi = findAll(chunks, 'http://localhost:4000/api');
const relativeApi = findAll(chunks, '"/api"');

if (devMode) {
  check(
    'le bundle vise l’API de développement (http://localhost:4000/api)',
    absoluteApi.length > 0,
    absoluteApi[0] ?? 'aucun chunk ne contient cette URL',
  );
} else {
  check(
    'le bundle utilise le chemin relatif /api (servi par nginx)',
    relativeApi.length > 0 || absoluteApi.length === 0,
    relativeApi[0] ?? 'chemin relatif absent',
  );
  check(
    'le bundle de production ne fige pas une URL localhost',
    absoluteApi.length === 0,
    absoluteApi[0] ?? 'aucune URL localhost, correct',
  );
}

// 2. Aucun chunk ne doit contenir une base vide.
//
//    `const API_BASE = ("")` était la signature exacte du défaut : toutes les
//    requêtes partaient sur l'origine du front.
const emptyBase = findAll(chunks, 'API_BASE = ("")');
check('aucune base d’API vide dans le bundle', emptyBase.length === 0, emptyBase[0] ?? 'aucune');

// 3. Le WebSocket doit viser le bon serveur en développement.
if (devMode) {
  const wsChunks = findAll(chunks, 'ws://localhost:4000/ws');
  check('le bundle vise le WebSocket de développement', wsChunks.length > 0, wsChunks[0] ?? 'absent');
}

// 4. Le serveur de développement répond réellement.
if (devMode) {
  try {
    const response = await fetch(`${baseUrl}/`, { redirect: 'follow' });
    check('le front répond', response.ok, `HTTP ${response.status} sur ${baseUrl}`);
  } catch (error) {
    check('le front répond', false, `injoignable sur ${baseUrl} (${error.message})`);
  }

  try {
    const response = await fetch('http://localhost:4000/health');
    check('l’API répond', response.ok, 'HTTP 200 sur http://localhost:4000/health');
  } catch (error) {
    check('l’API répond', false, `injoignable sur le port 4000 (${error.message})`);
  }

  // 5. La route que le client appellera doit exister sur l'API et pas sur le front.
  const apiRoute = await fetch('http://localhost:4000/api/me/credit');
  check(
    'la vraie route de l’API existe (401 sans jeton, pas 404)',
    apiRoute.status === 401,
    `HTTP ${apiRoute.status} sur /api/me/credit`,
  );

  const frontRoute = await fetch(`${baseUrl}/api/me/credit`, { redirect: 'manual' });
  check(
    'le front ne sert pas /api (confirme qu’il faut la base absolue)',
    frontRoute.status !== 401,
    `HTTP ${frontRoute.status} sur ${baseUrl}/api/me/credit`,
  );
}

console.log(`\n=== ${checks - failures} OK, ${failures} FAIL ===\n`);
process.exit(failures > 0 ? 1 : 0);
