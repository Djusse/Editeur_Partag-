/**
 * Génère des updates Yjs **distincts** pour le test de charge S2.
 *
 * ── Pourquoi ce fichier existe ───────────────────────────────────────────────
 * La première version de S2 envoyait à tous les VUs le **même** payload, codé en
 * dur. Le serveur déduplique par empreinte du contenu, en plus de l'`opId` : les
 * updates de même empreinte sont retirés du lot dans `commitBatch`, et les VUs
 * concernés n'obtenaient jamais d'acquittement.
 *
 * Mesure du 26/10 : 2 292 updates émis, **106 acquittés**, 50 diffusés, 0 erreur.
 * Le serveur ne refusait rien — il écartait silencieusement du contenu identique.
 *
 * Ce n'était pas seulement un défaut du serveur : c'était d'abord un défaut du
 * test. Cinquante rédacteurs qui insèrent le même caractère au même endroit
 * produisent **une** opération CRDT, pas cinquante. Ce n'est pas de la
 * concurrence, donc S2 ne mesurait pas ce qu'il annonçait.
 *
 * ── Comment les updates sont rendus distincts ───────────────────────────────
 * Chaque update provient d'un `Y.Doc()` différent. Un document Yjs tire un
 * identifiant de client aléatoire à sa création (`clientID`), et cet identifiant
 * est encodé dans le binaire de l'update. Deux documents distincts produisent
 * donc deux updates binairement différents, **même en insérant le même
 * caractère** : c'est exactement la situation de N rédacteurs qui tapent « x »
 * au début du texte.
 *
 * Le coût en crédit reste de 1 caractère par update : le comptage est fait sur
 * le binaire (`creditCost`), et une insertion d'un caractère vaut 1.
 *
 * ── Usage ──────────────────────────────────────────────────────────────────
 *   node tests/k6/gen-updates.mjs 20000 > tests/k6/data/updates.json
 *
 * `yjs` est résolu depuis `backend/node_modules`, comme dans
 * `verify-convergence.mjs` : les dépendances du backend sont les seules à
 * contenir Yjs côté outillage.
 */
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

const COUNT = Number(process.argv[2] || 20000);
const OUT = process.argv[3] || null;

if (!Number.isInteger(COUNT) || COUNT < 1 || COUNT > 200000) {
  console.error('Usage : node gen-updates.mjs <nombre 1..200000> [fichier de sortie]');
  process.exit(2);
}

/** Yjs vit dans backend/node_modules, pas à la racine du dépôt. */
async function loadYjs() {
  try {
    return await import('yjs');
  } catch {
    /* on tente l'emplacement connu */
  }
  try {
    return createRequire(new URL('../../backend/package.json', import.meta.url))('yjs');
  } catch {
    return null;
  }
}

const Y = await loadYjs();
if (!Y) {
  console.error(
    'yjs introuvable. Installer avec : cd backend && npm install',
  );
  process.exit(2);
}

const payloads = [];
const fingerprints = new Set();

for (let index = 0; index < COUNT; index++) {
  // Un document neuf par update : c'est le clientID aléatoire qui rend le
  // binaire distinct, sans changer le coût en crédit (1 caractère inséré).
  const doc = new Y.Doc();
  const updates = [];
  doc.on('update', (update) => updates.push(update));
  doc.getText('content').insert(0, 'x');

  const payload = Buffer.from(updates[0]).toString('base64');
  const fingerprint = createHash('sha256').update(updates[0]).digest('hex');

  // Garde-fou : si deux updates se ressemblaient, le test reproduirait le
  // défaut qu'il est censé éviter. On préfère échouer ici que mesurer faux.
  if (fingerprints.has(fingerprint)) {
    console.error(`Collision d'empreinte à l'index ${index} — génération invalide.`);
    process.exit(1);
  }
  fingerprints.add(fingerprint);
  payloads.push(payload);
  doc.destroy();
}

const json = JSON.stringify(payloads);

if (OUT) {
  mkdirSync(dirname(OUT), { recursive: true });
  writeFileSync(OUT, json);
  console.error(
    `${payloads.length} updates distincts écrits dans ${OUT} ` +
      `(${(json.length / 1024).toFixed(0)} Kio, ${fingerprints.size} empreintes uniques)`,
  );
} else {
  process.stdout.write(json);
}
