/**
 * Utilitaires partagés par les scénarios k6.
 *
 * Règles retenues :
 *  - **tout est paramétré par variables d'environnement** (`-e API_URL=…`) :
 *    aucun scénario ne fige une adresse, une IP ou un jeton ;
 *  - les helpers produisent des `check` nommés de façon stable, pour que les
 *    résultats soient comparables d'une exécution à l'autre ;
 *  - aucune dépendance npm : k6 n'exécute pas Node, seulement son propre moteur
 *    JavaScript (ESM supporté depuis la 0.43, `import` fonctionne).
 *
 * Convention d'appel :
 *   k6 run -e API_URL=http://13.53.160.209 -e TOKEN=<jwt> tests/k6/s1-claim.js
 */
import http from 'k6/http';
import { check } from 'k6';

/** Base de l'API du rédacteur (`/api`). */
export function apiBase() {
  const url = (__ENV.API_URL || 'http://localhost:4000').replace(/\/+$/, '');
  return `${url}/api`;
}

/** Base du parcours visiteur : les routes `/d/...` sont à la RACINE. */
export function visitorBase() {
  return (__ENV.API_URL || 'http://localhost:4000').replace(/\/+$/, '');
}

/** En-tête d'authentification à partir du JWT fourni par `-e TOKEN=…`. */
export function authHeaders() {
  return {
    'content-type': 'application/json',
    authorization: `Bearer ${__ENV.TOKEN || ''}`,
  };
}

export function jsonHeaders() {
  return { 'content-type': 'application/json' };
}

/**
 * Vérifie un prérequis et interrompt le scénario si besoin.
 *
 * k6 n'a pas d'assertion bloquante : un scénario qui démarre sans jeton valide
 * mesurerait des 401 et produirait des chiffres trompeurs. Mieux vaut échouer
 * au démarrage avec un message explicite.
 */
export function requireEnv(name) {
  const value = __ENV[name];
  if (!value) {
    throw new Error(
      `Variable d'environnement manquante : ${name}. ` +
        `Exemple : k6 run -e API_URL=http://<ip> -e TOKEN=<jwt> tests/k6/<scenario>.js`,
    );
  }
  return value;
}

/**
 * Identifiant de visiteur conforme au serveur (8 à 100 caractères).
 *
 * Il doit être **stable par visiteur** : le serveur s'en sert pour rendre un
 * claim idempotent. Un identifiant aléatoire à chaque requête simulerait des
 * visiteurs toujours nouveaux, ce qui n'est pas le cas d'usage réel.
 */
export function visitorId(prefix, index, runId) {
  return `v_${prefix}_${runId}_${String(index).padStart(6, '0')}`.slice(0, 100);
}

/** Identifiant d'exécution, pour que les jetons ne se mélangent pas entre runs. */
export function runId() {
  return __ENV.RUN_ID || String(Date.now());
}

/**
 * Appelle `POST /d/{token}/claim` et classe la réponse.
 *
 * États **normaux** du parcours visiteur, tous attendus sous charge :
 *   200 `ready`     — exemplaire réservé, PDF déjà en cache ;
 *   202 `waiting`   — exemplaire réservé, PDF en génération ;
 *   410 `exhausted` — aucun exemplaire disponible.
 *
 * Un 5xx est une anomalie : il est compté séparément dans les métriques.
 */
export function claim(token, visitor) {
  const url = `${visitorBase()}/d/${token}/claim`;
  const response = http.post(url, JSON.stringify({ visitorId: visitor }), {
    headers: jsonHeaders(),
    tags: { name: 'claim' },
  });

  let body = {};
  try {
    body = JSON.parse(response.body || '{}');
  } catch (error) {
    body = { state: 'unparseable' };
  }

  const state = body.state || 'unknown';
  check(response, {
    'claim : réponse 200/202/410 (ou 429 transitoire)': (r) =>
      r.status === 200 || r.status === 202 || r.status === 410 || r.status === 429,
  });

  return { status: response.status, state, body };
}

/** `GET /d/{token}/status` — état public, mis en micro-cache par nginx. */
export function linkStatus(token) {
  const response = http.get(`${visitorBase()}/d/${token}/status`, {
    tags: { name: 'status' },
  });
  let body = {};
  try {
    body = JSON.parse(response.body || '{}');
  } catch (error) {
    body = {};
  }
  return { status: response.status, body };
}

/** Crée un document et renvoie son identifiant. */
export function createDocument(title) {
  const response = http.post(`${apiBase()}/documents`, JSON.stringify({ title }), {
    headers: authHeaders(),
    tags: { name: 'create-document' },
  });
  const ok = check(response, {
    'document créé (201)': (r) => r.status === 201,
  });
  if (!ok) throw new Error(`Création de document impossible : HTTP ${response.status} ${response.body}`);
  return JSON.parse(response.body).id;
}

/** Crée un lien à quota `maxDownloads` sur un document. */
export function createLink(docId, maxDownloads) {
  const response = http.post(
    `${apiBase()}/documents/${docId}/links`,
    JSON.stringify({ maxDownloads }),
    { headers: authHeaders(), tags: { name: 'create-link' } },
  );
  const ok = check(response, {
    'lien créé (201)': (r) => r.status === 201,
  });
  if (!ok) throw new Error(`Création de lien impossible : HTTP ${response.status} ${response.body}`);
  return JSON.parse(response.body).token;
}

/**
 * Écrit du texte dans un document via le **repli HTTP**.
 *
 * `POST /api/documents/{id}/updates` suit exactement le même chemin que le
 * WebSocket : même transaction, même crédit, même idempotence. C'est ce qui
 * permet à S1 de préparer un document sans ouvrir 15 000 WebSockets.
 *
 * ⚠️ Le crédit est de 10 000 caractères par jour et par e-mail : S1 doit donc
 * préparer son document avec un compte **dédié**, distinct de celui des
 * rédacteurs de S2.
 */
export function writeViaHttp(docId, opId, base64Update) {
  const response = http.post(
    `${apiBase()}/documents/${docId}/updates`,
    JSON.stringify({ opId, update: base64Update }),
    { headers: authHeaders(), tags: { name: 'write-http' } },
  );
  return { status: response.status, body: response.body };
}

/** Métriques personnalisées, alimentées par les scénarios. */
export function counter(name) {
  return name;
}
