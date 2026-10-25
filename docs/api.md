# API — référence

Référence complète du service : routes HTTP, protocole temps réel, règles de
crédit. **Tout ce qui suit est vérifié contre le code** (`backend/src/routes/`,
`backend/src/realtime/`, `backend/src/lib/`) et non contre une intention.

Deux documents complémentaires :

- [`docs/api/openapi.yaml`](api/openapi.yaml) — description machine ;
- [`docs/api/websocket.md`](api/websocket.md) — détail du protocole temps réel.

---

## 1. Conventions

### 1.1 URL de base

L'interface et l'API partagent la **même origine** (nginx) : les chemins sont
donc relatifs côté client, et il n'y a ni CORS à configurer ni URL à injecter.

```
http://<elastic-ip>/
├── /                      interface (fichiers statiques)
├── /api/...               routes du rédacteur       → proxy vers Node
├── /d/{token}/...         parcours visiteur         → proxy vers Node
├── /ws                    WebSocket                → proxy (Upgrade)
├── /health                sonde de vie
└── /api/config            réglages publics, aucun secret
```

| Préfixe | Public | Authentification |
| - | - | - |
| `/api/session`, `/api/config`, `/health` | oui | aucune |
| `/api/documents/...`, `/api/me/...`, `/api/ws-ticket` | rédacteur | JWT (`Authorization`) |
| `/api/admin/state` | supervision | clé d'administration (`X-Admin-Key`) |
| `/d/{token}/...` | **visiteur** | aucune — le jeton du lien *est* la capacité |

⚠️ **Le parcours visiteur est à la RACINE, pas sous `/api`.** C'est un piège de
déploiement : `location /api/` est proxifié, `location /` sert les fichiers
statiques. Un lien public construit en `/api/d/{token}/claim` renverrait le
`index.html` du front avec un code 200 — donc un échec silencieux.

### 1.2 JSON

- Requêtes et réponses en `application/json; charset=utf-8` (sauf le PDF, qui
  n'est jamais servi par l'application : voir 4.3).
- Les dates sont des chaînes ISO 8601 en **UTC** (`2026-10-25T23:00:00.000Z`).
- Les charges binaires (updates Yjs, état initial) voyagent en **Base64**.
- Limite de corps HTTP : **1 Mio** (`bodyLimit`). Au-delà : `413`.

### 1.3 Authentification par jeton

`POST /api/session` délivre un **JWT HS256** signé par un secret stocké dans SSM
Parameter Store (`/editeur/jwt-secret`). Il n'y a **pas de mot de passe** : le
sujet autorise une identité légère (nom + e-mail), et cette limite est assumée
et documentée dans le dossier de conception.

```
Authorization: Bearer <header>.<payload>.<signature>
```

Charge utile :

```json
{ "email": "awa@exemple.cm", "name": "Awa", "iat": 1761400000, "exp": 1762004800 }
```

| Propriété | Valeur |
| - | - |
| Algorithme | HS256, comparaison à temps constant (`timingSafeEqual`) |
| Durée de vie | **7 jours** (`SESSION_TTL_SECONDS = 604800`) |
| Révocation | aucune : un jeton reste valable jusqu'à `exp` |
| Vérification | à chaque requête, **et** l'appartenance au document est revérifiée séparément |

Un JWT valide ne donne donc accès à rien : `requireAccess(docId, email)` consulte
la table `Members` à chaque appel. Un jeton volé ne permet pas de lire un
document dont l'e-mail n'est pas membre.

### 1.4 Format des erreurs

Une seule forme, jamais d'exception brute, jamais de 5xx silencieux :

```json
{ "error": "INVALID_INPUT", "field": "email", "message": "Adresse e-mail invalide." }
```

`error` est un **code texte stable** (c'est ce que l'interface teste) ; `message`
est destiné à l'humain et peut être reformulé sans casser de client.

| Code HTTP | `error` | Sens |
| - | - | - |
| 400 | `INVALID_INPUT` | champ absent ou mal formé ; `field` précise lequel |
| 401 | `UNAUTHORIZED` | jeton absent, malformé, signature invalide ou expiré |
| 403 | `FORBIDDEN` | authentifié, mais pas membre du document |
| 403 | `CREDIT_EXHAUSTED` | crédit du jour épuisé (repli HTTP d'écriture) |
| 403 | `BLOCKED` | écriture suspendue après trop de refus ; `blockedUntil` fourni |
| 404 | `NOT_FOUND` | document, version ou lien inexistant |
| 409 | `ALREADY_MEMBER` | la personne a déjà accès au document |
| 410 | `NO_TICKET` | `GET /d/{token}/file` sans réservation préalable |
| 413 | `PAYLOAD_TOO_LARGE` | update au-delà de 64 Kio de binaire |
| 503 | `PDF_UNAVAILABLE` | génération du PDF en échec définitif (3 tentatives) |
| 500 | `INTERNAL_ERROR` | erreur non gérée ; le détail reste dans les journaux |

### 1.5 Codes HTTP de succès

| Code | Quand |
| - | - |
| 200 | lecture, mise à jour, restauration, claim servi |
| 201 | **création** : document, membre, version, lien, ticket WebSocket |
| 202 | claim en attente (`waiting`) : exemplaire réservé, PDF en génération |

Le `201` sur `POST /api/ws-ticket` a causé une panne de test de charge : les
scénarios k6 exigeaient `200` et comptaient donc 100 % d'échecs
([`tests/k6/s2-convergence.js`](../tests/k6/s2-convergence.js:1)).

---

## 2. Sessions et identité

### 2.1 `POST /api/session`

Crée (ou retrouve) une identité et renvoie un jeton. **Aucune inscription, aucun
mot de passe** : l'e-mail est la clé d'identité.

```http
POST /api/session
Content-Type: application/json

{ "name": "Awa", "email": "Awa@Exemple.CM" }
```

| Champ | Contrainte |
| - | - |
| `name` | requis, **60 caractères** max (`NAME_MAX`) |
| `email` | requis, format validé, **normalisé en minuscules** |

Réponse `200` :

```json
{
  "token": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9....",
  "user": { "name": "Awa", "email": "awa@exemple.cm" },
  "credit": {
    "limit": 10000, "used": 0, "remaining": 10000,
    "day": "2026-10-25", "blockedUntil": null,
    "resetsAt": "2026-10-25T23:00:00.000Z", "resetsIn": 41723
  }
}
```

Le crédit est renvoyé dès la session pour que l'interface affiche une jauge juste
sans second appel.

Erreurs : `400 INVALID_INPUT` avec `field: "name"` ou `field: "email"`.

### 2.2 `GET /api/me/credit`

```http
GET /api/me/credit
Authorization: Bearer <jwt>
```

Réponse `200` :

```json
{
  "limit": 10000,
  "used": 7420,
  "remaining": 2580,
  "day": "2026-10-25",
  "blockedUntil": null,
  "resetsAt": "2026-10-25T23:00:00.000Z",
  "resetsIn": 41723
}
```

| Champ | Sens |
| - | - |
| `limit` | plafond quotidien (10 000 par défaut) |
| `used` | caractères facturés aujourd'hui (insertions **et** suppressions) |
| `remaining` | `max(0, limit - used)` |
| `day` | **jour métier de Douala** (`YYYY-MM-DD`), pas le jour UTC |
| `blockedUntil` | `null`, ou terme du blocage — **toujours** le prochain minuit de Douala |
| `resetsAt` | instant de la remise à zéro, en UTC (`23:00Z` = minuit à Douala) |
| `resetsIn` | secondes restantes (commodité d'affichage) |

`blockedUntil` n'est **pas** relu tel quel en base : il est recalculé à partir de
`nextUtcMidnight()`. Cette décision corrige les lignes écrites sous l'ancienne
règle (jour UTC), qui annonçaient « 01:00 » alors que la recharge tombait à
minuit local. Voir §6.

---

## 3. Documents

Toutes les routes de cette section exigent `Authorization: Bearer <jwt>` **et**
l'appartenance au document (sauf la création et la liste).

### 3.1 Création, liste, lecture, état

#### `POST /api/documents`

```json
{ "title": "Rapport de stage" }
```

| Champ | Contrainte |
| - | - |
| `title` | requis, **120 caractères** max (`TITLE_MAX`), non vide après nettoyage |

Réponse `201` :

```json
{ "id": "doc_K7f2mQx1", "title": "Rapport de stage" }
```

L'identifiant est de la forme `doc_` + 12 caractères base64url. Le créateur
devient membre avec le rôle `owner` **dans la même transaction** que la création
du document : un document sans propriétaire ne peut pas exister.

#### `GET /api/documents`

Liste les documents dont l'appelant est membre (via l'index `email-index` de la
table `Members`), du plus récemment modifié au plus ancien.

```json
{
  "documents": [
    {
      "id": "doc_K7f2mQx1",
      "title": "Rapport de stage",
      "ownerName": "Awa",
      "ownerEmail": "awa@exemple.cm",
      "updatedAt": "2026-10-25T20:14:03.221Z",
      "role": "owner"
    }
  ]
}
```

#### `GET /api/documents/{id}`

```json
{
  "id": "doc_K7f2mQx1",
  "title": "Rapport de stage",
  "ownerEmail": "awa@exemple.cm",
  "ownerName": "Awa",
  "members": [
    { "email": "awa@exemple.cm", "name": "Awa", "role": "owner" },
    { "email": "boris@exemple.cm", "name": "boris", "role": "editor" }
  ]
}
```

Le propriétaire est toujours en tête de liste. Erreurs : `404 NOT_FOUND`,
`403 FORBIDDEN`.

#### `GET /api/documents/{id}/state`

État Yjs **complet et compacté**. C'est le point de départ de tout client : il
reconstruit le document en un seul `Y.applyUpdate`.

```json
{ "seq": 142, "state": "AQGd+OWCBAAEAQdjb250ZW50AXgA..." }
```

| Champ | Sens |
| - | - |
| `seq` | dernier numéro de séquence intégré ; à passer tel quel comme `sinceSeq` au `join` WebSocket |
| `state` | update Yjs (Base64), état complet et non un delta |

⚠️ Joindre le WebSocket avec `sinceSeq: 0` au lieu de cette valeur rejoue **tout
le journal** à chaque connexion. Mesuré lors d'un test de charge :
90 513 messages reçus pour 0 update acquitté. Le serveur a raison de rejouer ;
c'est au client de ne pas le lui demander.

#### `GET /api/documents/{id}/updates?since={seq}`

Rattrapage du journal — c'est ce qu'un client utilise après une coupure.

| Paramètre | Sens |
| - | - |
| `since` | renvoyer les entrées de `seq` **strictement supérieur** ; `0` = tout le journal |

```json
{
  "updates": [
    { "seq": 143, "payload": "AQGd+OWCBAAEAQdjb250ZW50AXgA..." },
    { "seq": 144, "payload": "..." }
  ]
}
```

⚠️ **La réponse est plafonnée à 2000 entrées** (`MAX_UPDATES_PER_CATCH_UP`), et
aucun paramètre ne permet d'en demander moins ou plus. Le serveur pagine en
interne par pages DynamoDB de 500, puis **s'arrête à 2000**
(`manager.fetchUpdates`).

Conséquence à connaître : sur un document dont le journal dépasse 2000 entrées, un
appel unique ne renvoie **pas** tout l'historique — et **rien dans la réponse ne
signale la troncature**. Pour un rattrapage complet, il faut donc **boucler** en
déplaçant `since` sur le dernier `seq` reçu, jusqu'à obtenir une réponse vide.
C'est ce que fait
[`tests/node/verify-convergence.mjs`](../tests/node/verify-convergence.mjs:1) ;
sans cette boucle, la vérification de convergence porterait sur un journal
partiel et conclurait à tort.

#### `POST /api/documents/{id}/updates` — repli HTTP de l'édition

Suit **exactement** le même chemin que le WebSocket : même transaction, même
crédit, même idempotence. Un client sans WebSocket conserve donc la garantie C2.

```json
{ "opId": "op_8f14e45f-...", "update": "<Base64>" }
```

Réponse `200` :

```json
{ "ack": { "opIds": ["op_8f14e45f-..."], "seq": 143, "creditRemaining": 7420 } }
```

Erreurs : `400 INVALID_INPUT` (`opId` absent ou > 100 caractères, update
illisible), `413 PAYLOAD_TOO_LARGE`, `403 CREDIT_EXHAUSTED` / `403 BLOCKED` avec
`opId`, `creditRemaining`, `resetsAt` et `blockedUntil`.

> ⚠️ Une version antérieure répondait `ack` alors que la transaction avait été
> refusée : le client croyait son update enregistré. La réponse 403 est la
> correction, et c'est ce qui explique que ce repli soit aujourd'hui fiable.

### 3.2 Membres et partage

#### `POST /api/documents/{id}/members`

```json
{ "email": "boris@exemple.cm" }
```

Réponse `200` : la liste complète à jour, `{ "members": [ … ] }`.

| Cas | Réponse |
| - | - |
| e-mail invalide | `400 INVALID_INPUT`, `field: "email"` |
| personne déjà membre | `409 ALREADY_MEMBER` |
| appelant non membre | `403 FORBIDDEN` |

Le nom du nouveau membre est dérivé de la partie locale de l'adresse
(`boris@…` → `boris`) ; le rôle attribué est `editor`. Il n'existe **pas** de
route de retrait de membre : le partage est additif.

Conséquence pratique pour les tests de charge : un compte fraîchement créé n'est
membre de rien et `POST /api/ws-ticket` lui répond `403`. C'est exactement ce qui
a fait échouer 2 250 tickets lors du premier essai de S2 — le script
[`mktokens.sh`](../tests/k6/mktokens.sh:1) ajoute désormais chaque compte comme
rédacteur.

### 3.3 Versions : création, liste, restauration

Une version est un **snapshot Yjs complet** écrit dans S3, plus une ligne dans la
table `Versions`. Elle est identifiée par `n`, qui **est** le `seq` du document
au moment de l'enregistrement — d'où l'absence de trous dans la numérotation.

Une version automatique est prise toutes les **50 entrées** de journal ou toutes
les **2 minutes** d'activité, ainsi qu'avant chaque restauration. L'interface
n'expose aucun bouton de création automatique, mais
`POST /documents/{id}/versions` permet un enregistrement explicite : sans lui, un
document fraîchement créé n'avait aucune version et la modale « Versions »
paraissait cassée.

#### `GET /api/documents/{id}/versions`

Les 100 versions les plus récentes, `n` décroissant.

```json
{
  "versions": [
    { "n": 142, "createdAt": "2026-10-25T20:14:03.221Z", "authorName": "Awa", "chars": 3120 }
  ]
}
```

#### `POST /api/documents/{id}/versions`

Enregistre une version **maintenant**. Réponse `201` :

```json
{ "version": { "n": 143, "chars": 3120, "createdAt": "2026-10-25T20:19:44.000Z" } }
```

L'opération est idempotente : si le `seq` n'a pas bougé, la ligne existe déjà et
la seconde écriture échoue silencieusement sur sa condition.

#### `POST /api/documents/{id}/versions/{n}/restore`

```json
{ "seq": 158 }
```

La restauration procède en trois temps :

1. **sauvegarde de l'état courant** en tant que version (le texte qu'on écrase
   reste donc consultable) ;
2. lecture du snapshot `n` dans S3 et calcul du **diff** avec l'état courant réel ;
3. publication d'un **nouvel update** qui remplace le texte — et non un retour en
   arrière de l'historique.

Trois propriétés en découlent, et elles sont volontaires :

| Propriété | Raison |
| - | - |
| Compatible CRDT | on ajoute un update, on ne supprime aucune opération : les autres clients convergent au lieu de diverger |
| Historique conservé | rien n'est effacé ; la restauration est elle-même une révision |
| **Gratuite** en crédit | update dit « système » : `chars = 0`, et il franchit un blocage |

Le troisième point est une décision explicite : une restauration doit aboutir
même si l'auteur a épuisé son crédit et s'est fait bloquer, sinon il serait
enfermé sans recours.

Erreurs : `404 NOT_FOUND` (version inconnue), `400 INVALID_INPUT` (`n` non entier
positif).

> ⚠️ Une restauration ne « ramène » pas les autres clients en arrière par
> téléportation : elle insère les différences. Un client qui a des frappes
> locales **non émises** les verra réconciliées par le CRDT, ce qui peut
> ressembler à une divergence dans une capture d'écran. La convergence est
> vérifiée par [`tests/node/verify-convergence.mjs`](../tests/node/verify-convergence.mjs:1).

---

## 4. Liens de téléchargement

Un lien public donne droit à **exactement N téléchargements** du PDF. C'est la
contrainte éliminatoire C1 : ni N+1, ni N-1.

### 4.1 Création, liste, révocation

#### `POST /api/documents/{id}/links`

```json
{ "maxDownloads": 500 }
```

| Champ | Contrainte | Défaut |
| - | - | - |
| `maxDownloads` | entier, **1 à 100 000** | `500` |

Réponse `201` :

```json
{
  "token": "9Xk3pQ7rT2mVbL8n",
  "maxDownloads": 500,
  "remaining": 500,
  "status": "ACTIVE",
  "createdAt": "2026-10-25T20:19:44.000Z"
}
```

Le jeton fait 16 octets aléatoires en base64url : il est **imprévisible**, ce qui
est la seule protection du parcours visiteur. Il ne faut donc pas le confondre
avec un identifiant public anodin.

`status` vaut `ACTIVE` ou `EXHAUSTED`. La transition est **monotone** :
`ACTIVE → EXHAUSTED` une seule fois, posée par le claim qui amène réellement
`remaining` à zéro, sous condition `remaining = 0 AND status = ACTIVE`. Deux
visiteurs concurrents ne peuvent pas la poser deux fois.

#### `GET /api/documents/{id}/links`

```json
{
  "links": [
    {
      "token": "9Xk3pQ7rT2mVbL8n",
      "maxDownloads": 500,
      "remaining": 0,
      "status": "EXHAUSTED",
      "createdAt": "2026-10-25T20:19:44.000Z"
    }
  ]
}
```

Triés du plus récent au plus ancien. Tous les liens du document, épuisés compris.

#### Révocation

**Il n'existe pas de route de révocation.** Aucun `DELETE`, aucun
`PATCH /links/{token}` : la table ne porte pas de champ `revokedAt`, et
l'interface n'offre pas de bouton. C'est un écart assumé par rapport à
l'intitulé « révocation », à connaître avant la soutenance.

Les leviers réels pour arrêter la distribution d'un document sont donc :

| Levier | Effet | Limite |
| - | - | - |
| Laisser le quota s'épuiser | `410 exhausted` pour tous les nouveaux visiteurs | nécessite N claims |
| Créer un lien au quota voulu | nouveau jeton, l'ancien reste actif | ne coupe rien |
| Retirer un membre | coupe l'**édition**, pas la distribution | sans effet sur les liens |

Un visiteur qui a **déjà** réservé son exemplaire conserve son téléchargement,
même après épuisement : c'est exigé par la spécification et implémenté
explicitement (voir 4.2, étape 1).

### 4.2 Parcours visiteur

Aucune identité, aucun en-tête : le jeton du lien est la capacité. Les trois
routes sont **à la racine**, pas sous `/api`.

#### `GET /d/{token}/status`

Interroge l'état **sans consommer** d'exemplaire. C'est ce qu'appelle la page
avant que le visiteur ne clique.

```json
{ "status": "active", "title": "Rapport de stage", "remaining": 42 }
```

| `status` | Sens |
| - | - |
| `active` | au moins un exemplaire disponible (`remaining > 0`) |
| `exhausted` | plus aucun exemplaire (`remaining = 0`) |

En-têtes de cache (honorés par nginx via `X-Accel-Expires`) :

| État | `cache-control` | `x-accel-expires` | Raison |
| - | - | - | - |
| `active` | `public, max-age=1` | `1` | micro-cache : absorbe le pic de `/status` sans retarder l'épuisement de plus d'une seconde |
| `exhausted` | `public, max-age=60` | `60` | C6 : plus aucun calcul, la réponse est mémorisée |

Erreur : `404 NOT_FOUND` si le jeton n'existe pas.

#### `POST /d/{token}/claim`

Réserve un exemplaire. `visitorId` est fourni par le client et rend l'appel
**idempotent** : le même visiteur qui réappelle récupère **son** exemplaire, sans
en consommer un second.

```http
POST /d/{token}/claim
Content-Type: application/json

{ "visitorId": "v_s5_1761400000000_000042" }
```

| Champ | Contrainte |
| - | - |
| `visitorId` | **8 à 100 caractères** après `trim` ; doit rester **stable** par visiteur |

L'ordre des vérifications est imposé par la spécification et a des conséquences
observables :

1. **le visiteur a-t-il déjà un ticket ?** → on le sert immédiatement. Cette
   étape est **avant** le court-circuit `exhausted` : sans elle, un visiteur
   possessing déjà son exemplaire recevrait `410` après l'épuisement du lien.
2. lien déjà épuisé → `410`, sans autre travail (C6).
3. garde mémoire (50 claims simultanés par lien) → `202 waiting` : on protège
   DynamoDB du pic, on ne refuse **jamais** un exemplaire.
4. sinon, boucle de tentatives avec transaction conditionnelle
   (`ADD remaining -1` **si** `remaining > 0 AND status = ACTIVE`, plus `Put`
   du ticket sous `attribute_not_exists(visitorId)`).

**T1 est figé ici** : `seqFrozen` est lu au moment du claim, en prenant le dernier
`seq` réellement écrit. Tous les visiteurs d'une même rafale reçoivent donc le
même PDF, et une modification ultérieure du document ne change pas leur fichier.

#### `GET /d/{token}/file?visitorId=...`

Reprise du téléchargement après une attente. Aucun exemplaire n'est consommé :
la réservation a déjà eu lieu.

```http
GET /d/{token}/file?visitorId=v_s5_1761400000000_000042
```

Erreur `410 NO_TICKET` si ce visiteur n'a jamais réservé sur ce lien.

### 4.3 États possibles et réponses

Les deux routes `claim` et `file` renvoient **le même format**, distingué par le
code HTTP.

| Code | Corps | Sens | En-têtes |
| - | - | - | - |
| `200` | `{ "state": "ready", "url": "https://…", "expiresIn": 60 }` | exemplaire réservé, PDF disponible | `cache-control: no-store` |
| `202` | `{ "state": "waiting", "retryAfter": 2 }` | exemplaire réservé, PDF en génération | `cache-control: no-store`, `retry-after` |
| `410` | `{ "state": "exhausted" }` | aucun exemplaire disponible | `public, max-age=60` |
| `503` | `{ "error": "PDF_UNAVAILABLE", … }` | génération en échec 3 fois | — |

Trois conséquences d'implémentation à connaître :

**L'URL du PDF est présignée** (60 s, `PDF_URL_TTL_SECONDS`), jamais un flux
traversant l'application. Le fichier est servi par S3 directement : le téléchargement
de 500 PDF ne consomme donc pas la bande passante de l'instance. Le nom du
fichier est dérivé du titre (`Rapport de stage.pdf`), accents et casse conservés ;
seuls les caractères interdits sont remplacés.

**`202 waiting` n'est jamais un échec.** C'est l'état normal d'un PDF en cours de
construction. La génération est un travail SQS : un seul claimant arme un verrou
de 120 s (`leaseUntil`) et publie le job ; les autres attendent sans publier.
Trois échecs consécutifs font basculer en `503` plutôt que de faire patienter
indéfiniment.

**Un `410 exhausted` n'est pas une erreur de requête** au sens de k6 : il est
compté comme `http_req_failed`. Un seuil `http_req_failed < 0.01` sur le scénario
visiteur est donc inatteignable par construction — mesuré à 84 % sans la moindre
panne. Les scripts de charge surveillent les 5xx par un compteur dédié.

---

## 5. Temps réel (WebSocket)

Protocole complet : [`docs/api/websocket.md`](api/websocket.md). Cette section en
donne la vue d'ensemble et les pièges.

### 5.1 Obtention du ticket et connexion

Le navigateur ne permet pas d'ajouter un en-tête `Authorization` au handshake
WebSocket : on passe par un **ticket à usage unique** dans l'URL. C'est ce qui
évite d'exposer un JWT durable dans les journaux nginx.

#### `POST /api/ws-ticket`

```json
{ "documentId": "doc_K7f2mQx1" }
```

Réponse **`201`** :

```json
{ "ticket": "3nQ8…", "expiresIn": 60, "documentId": "doc_K7f2mQx1" }
```

| Propriété | Valeur |
| - | - |
| Durée de vie | **60 s** (`WS_TICKET_TTL_SECONDS`) |
| Usage | **une seule fois** (`consumeTicket` supprime l'entrée) |
| Stockage | mémoire du processus — un redémarrage invalide les tickets en vol |
| Accès | vérifié **à l'émission** (`requireAccess`) **et** à la connexion |

#### Connexion

```
ws://<elastic-ip>/ws?ticket=<ticket>&documentId=<docId>
```

En HTTPS, `wss:`. Le front le déduit de `location.protocol`, jamais écrit en dur.
nginx transmet `Upgrade` et `Connection` via une carte `$connection_upgrade`.

Un ticket invalide, expiré ou déjà consommé ferme la connexion avec le code
applicatif `FORBIDDEN` (fermeture `1008`), après un message `error`.

### 5.2 Messages

#### Client → serveur

| `type` | Corps | Rôle |
| - | - | - |
| `join` | `{ documentId, sinceSeq }` | demande les updates manquants depuis `sinceSeq` |
| `update` | `{ opId, documentId, payload }` | propose une modification (Base64) |
| `awareness` | `{ documentId, payload }` | curseurs (≤ 16 Ko, ignoré au-delà) |
| `ping` | `{}` | sonde ; répond `pong` |

#### Serveur → client

| `type` | Corps | Rôle |
| - | - | - |
| `joined` | `{ connectionId, documentId, seq, you, creditRemaining, resetsAt, readOnly?, blockedUntil?, caughtUp? }` | connexion établie, état du crédit |
| `update` | `{ seq, documentId, payload }` | **un seul message par tick** (250 ms), updates fusionnés |
| `ack` | `{ opIds, seq, creditRemaining }` | acquittement **par expéditeur** |
| `presence` | `{ users }` | liste des connectés |
| `awareness` | `{ documentId, payload }` | curseur d'un autre participant |
| `error` | `{ code, opId?, message, creditRemaining?, blockedUntil? }` | refus explicite |

**`joined` arrive deux fois** et ce n'est pas un bug : une première fois
immédiatement à l'ouverture (avec `you`, `creditRemaining`, `readOnly`), une
seconde en réponse au `join` (avec `caughtUp` = nombre d'updates rejoués). Un
client doit traiter la première comme l'état initial et la seconde comme la fin
du rattrapage.

`readOnly` est renvoyé **à chaque** `joined`, y compris ceux de `join`. Le client
ne doit rejouer la procédure de rejet qu'**une seule fois** : mémoriser le code
reçu, sinon chaque reconnexion déclenche une reconstruction du document, qui
ouvre une connexion, qui renvoie `readOnly`… boucle infinie. C'est un défaut
réellement observé et corrigé.

#### `resync`

**Il n'existe pas de message nommé `resync`.** Le rattrapage se fait de deux
façons, et il faut le savoir pour ne pas chercher un message fantôme :

1. **WebSocket** : envoyer `join` avec `sinceSeq` = dernier `seq` connu. Le
   serveur renvoie les `update` manquants, puis `joined` avec `caughtUp`.
2. **HTTP** : `GET /api/documents/{id}/updates?since={seq}`, puis appliquer les
   updates dans l'ordre.

Un client qui reçoit un `seq` supérieur à `lastSeq + 1` a détecté un trou
(anormal) : c'est le signal qui doit déclencher l'un des deux rattrapages.

#### Codes d'erreur WebSocket

| `code` | Effet attendu côté client |
| - | - |
| `CREDIT_EXHAUSTED` | lecture seule, file vidée, document reconstruit depuis le serveur |
| `BLOCKED` | idem, avec `blockedUntil` pour le bandeau |
| `FORBIDDEN` | lecture seule, « Vous n'avez plus accès à ce document. » |
| `PAYLOAD_TOO_LARGE` | **l'écriture reste possible** ; seule cette modification est perdue |
| `INVALID_UPDATE` | update illisible : abandonné |
| `INVALID_OP_ID` | bug client : `opId` absent ou > 100 caractères |
| `WRITE_FAILED` | échec de persistance (DynamoDB) : le lot est réessayé, l'utilisateur est averti |

Un refus **n'est jamais un 500** et **ne coupe pas** la connexion : la lecture et
la présence restent actives.

### 5.3 Format des mises à jour et limite de taille

Un `payload` est un **update Yjs binaire** encodé en Base64. Ce n'est pas du JSON
applicatif : la structure interne décrit des opérations CRDT (insertions,
suppressions, marqueurs de formatage).

| Contrainte | Valeur | Conséquence |
| - | - | - |
| Plafond d'un update | **64 Kio de binaire** (`MAX_UPDATE_BYTES`) | au-delà : `PAYLOAD_TOO_LARGE`, refusé, écriture toujours possible |
| Découpage | **interdit** | un update Yjs est un bloc indécoupable ; le client ne le scinde jamais |
| Coût en crédit | `insertions + suppressions` | les suppressions sont facturées comme les insertions |
| Idempotence | par `opId` **et** par empreinte du contenu | un renvoi ne débite pas deux fois |
| Taille de corps HTTP | 1 Mio | au-delà : `413` avant même l'analyse |

En pratique, le crédit (10 000 caractères/jour) borne les insertions bien avant
la limite de 64 Kio : un update dépasse rarement quelques Ko. La limite existe
pour empêcher un client défaillant d'imposer une écriture géante.

---

## 6. Crédit quotidien

Quatre règles, chacune associée à un défaut réellement rencontré.

### 6.1 Décompte

| Règle | Valeur |
| - | - |
| Plafond | **10 000 caractères** par jour et par **e-mail** (`CREDIT_PER_DAY`) |
| Coût d'un update | `insertions + suppressions` (une suppression coûte 1) |
| Portée | l'e-mail, pas la connexion : 5 appareils partagent le même compteur |
| Clé | `email#jour` dans la table `Credits` |

Les suppressions sont facturées : sans cela, écrire puis effacer serait gratuit,
et le plafond serait contournable en trois clics.

### 6.2 Refus

Quand `used + chars > limit` :

1. l'update **n'est pas** persisté — aucune écriture partielle, aucun `seq`
   consommé ;
2. l'auteur reçoit `error` avec `CREDIT_EXHAUSTED` (WebSocket) ou
   `403 CREDIT_EXHAUSTED` (repli HTTP) ;
3. un **refus est enregistré** pour la journée.

Un même `opId` rejoué ne compte **qu'un seul refus** (marqueur conditionnel dans
la table `OpIds`) : sinon un client qui réessaie en boucle se bloquerait lui-même
sans avoir réellement réessayé.

> ⚠️ Le contrôle du crédit se fait par **lecture préalable**, pas dans la
> `ConditionExpression`. DynamoDB **refuse l'arithmétique entre deux valeurs** :
> `used + :chars <= :limit` lève
> `ValidationException: Invalid ConditionExpression: Syntax error; token: "+"`.
> Ce défaut est resté invisible en test parce que le double en mémoire évaluait
> lui-même l'expression — il était plus permissif que le vrai service. Le risque
> de course est borné par l'écrivain unique du hub ; la transaction reste la
> garde d'atomicité pour `seq`, le journal et les marqueurs `opId`.

### 6.3 Blocage

Après **4 refus** dans la même journée (`BLOCK_AFTER_REFUSALS`), l'écriture est
**suspendue** jusqu'à la remise à zéro :

- `error` avec `BLOCKED` et `blockedUntil` ;
- la lecture, la présence et le téléchargement restent possibles ;
- les updates **système** (restauration de version) passent malgré le blocage —
  une restauration est gratuite et doit rester un recours.

La garde est vérifiée à deux endroits : à l'entrée du WebSocket
(`assertNotBlocked`) **et** au début de chaque lot d'écriture (`blockedUntilFor`).
Le second contrôle est nécessaire : un lot peut franchir le seuil de refus
pendant son traitement, et sans lui l'update suivant était acquitté et facturé
alors que l'écriture était déjà suspendue.

### 6.4 Remise à zéro

**Minuit heure de Douala (UTC+1), soit 23:00 UTC**, et non minuit UTC.

| Aspect | Choix |
| - | - |
| Fuseau | fixé en dur (`BUSINESS_UTC_OFFSET_MINUTES = 60`) |
| Raison | le Cameroun n'a pas d'heure d'été : le décalage est constant toute l'année |
| Jour métier | `utcDay()` décale la date de +1 h avant d'extraire `YYYY-MM-DD` |
| Terme du blocage | **recalculé** à chaque lecture depuis `nextUtcMidnight()`, jamais relu en base |

Le dernier point corrige un défaut visible : `blockedUntil` était stocké comme
une date absolue, si bien que les lignes écrites du temps de la règle UTC
annonçaient encore « 01:00 » après le changement de règle. Calculer le terme
corrige les données existantes **sans migration**.

`resetsAt` d'une session ouverte à 20:19 heure de Douala vaut donc
`2026-10-25T23:00:00.000Z`, et `resetsIn` décompte les secondes jusque-là.

---

## 7. Administration

### `GET /api/admin/state`

Supervision en lecture seule, protégée par une **clé d'administration** stockée
dans SSM (`/editeur/admin-key`), transmise dans l'en-tête `X-Admin-Key` — et non
par le JWT : la clé est un secret d'exploitation, pas une identité.

```http
GET /api/admin/state
X-Admin-Key: <clé>
```

Réponse `200` — trois blocs, comme demandé par la spécification d'interface :

```json
{
  "openDocuments": [
    { "docId": "doc_K7f2mQx1", "title": "Rapport de stage", "connections": 3 }
  ],
  "activeLinks": [
    { "token": "9Xk3pQ7rT2mVbL8n", "docId": "doc_K7f2mQx1", "title": "Rapport de stage",
      "maxDownloads": 500, "remaining": 42 }
  ],
  "blocked": [
    { "email": "spam@exemple.cm", "blockedUntil": "2026-10-25T23:00:00.000Z" }
  ]
}
```

| Bloc | Contenu | Source |
| - | - | - |
| `openDocuments` | documents ayant au moins une connexion WebSocket ouverte | mémoire du hub |
| `activeLinks` | liens `ACTIVE` avec `remaining > 0` | table `Links` |
| `blocked` | blocages du **jour courant** encore valides | table `Abuse` |

Erreur : `401 UNAUTHORIZED` si la clé est absente ou différente. La comparaison
est stricte (`!==`), sur une valeur lue dans SSM à chaque appel — pas de clé en
mémoire, pas de clé dans le dépôt.

---

## 8. Exemples complets

### 8.1 Parcours visiteur, en `curl`

```bash
API=http://13.53.160.209

# 1. L'auteur se connecte et crée un document
TOKEN=$(curl -s -X POST "$API/api/session" \
  -H 'content-type: application/json' \
  -d '{"name":"Awa","email":"awa@exemple.cm"}' \
  | python3 -c 'import json,sys; print(json.load(sys.stdin)["token"])')

DOC=$(curl -s -X POST "$API/api/documents" \
  -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d '{"title":"Rapport de stage"}' \
  | python3 -c 'import json,sys; print(json.load(sys.stdin)["id"])')

# 2. Un lien de 3 exemplaires
LINK=$(curl -s -X POST "$API/api/documents/$DOC/links" \
  -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d '{"maxDownloads":3}' \
  | python3 -c 'import json,sys; print(json.load(sys.stdin)["token"])')

# 3. Le visiteur interroge l'état — ne consomme rien
curl -s "$API/d/$LINK/status"
# → {"status":"active","title":"Rapport de stage","remaining":3}

# 4. Il réserve au clic (visitorId stable, 8 à 100 caractères)
curl -s -X POST "$API/d/$LINK/claim" \
  -H 'content-type: application/json' \
  -d '{"visitorId":"v_demo_00000001"}'
# → 202 {"state":"waiting","retryAfter":2}   (le PDF se génère)
# → 200 {"state":"ready","url":"https://…","expiresIn":60}

# 5. Il rejoue le même visitorId : même exemplaire, pas un second
curl -s -X POST "$API/d/$LINK/claim" \
  -H 'content-type: application/json' \
  -d '{"visitorId":"v_demo_00000001"}'

# 6. Trois visiteurs épuisent le quota
for i in 2 3; do
  curl -s -o /dev/null -X POST "$API/d/$LINK/claim" \
    -H 'content-type: application/json' \
    -d "{\"visitorId\":\"v_demo_0000000$i\"}"
done
curl -s "$API/d/$LINK/status"
# → {"status":"exhausted", …}

# 7. Un quatrième visiteur : 410, et surtout PAS de 200
curl -s -o /dev/null -w '%{http_code}\n' -X POST "$API/d/$LINK/claim" \
  -H 'content-type: application/json' \
  -d '{"visitorId":"v_demo_00000009"}'
# → 410
```

Vérification C1 (N exactement, jamais N+1) :

```bash
curl -s "$API/api/documents/$DOC/links" -H "authorization: Bearer $TOKEN"
# → remaining: 0, status: "EXHAUSTED"
```

### 8.2 Parcours d'écriture, en `k6`

Le scénario complet est [`tests/k6/s2-convergence.js`](../tests/k6/s2-convergence.js:1).
Il ouvre une connexion **persistante** par rédacteur (`k6/ws`), écrit à cadence
réglable et vérifie que **chaque update émis a reçu son `ack`**.

```bash
# Préparation : N comptes, tous membres du document
./tests/k6/mktokens.sh 4 /tmp/tokens.txt "$DOC" "$TOKEN"

k6 run -e API_URL=http://13.53.160.209 \
       -e TOKEN=$(cut -d: -f2 /tmp/tokens.txt | paste -sd, -) \
       -e DOC_ID=$DOC \
       -e WRITERS=50 -e DURATION=45s -e PACE_MS=1000 \
       tests/k6/s2-convergence.js
```

Points d'implémentation qui comptent :

| Point | Pourquoi |
| - | - |
| `import { WebSocket }` **n'existe pas** dans k6 | il faut `k6/ws` : `k6/experimental/websocket` et `k6/websocket` sont inconnus de v0.54 et `k6/websocket` n'apparaît qu'en v1.0 |
| `sinceSeq` lu depuis `/state` | avec `0`, tout le journal est rejoué à chaque connexion |
| `PACE_MS = 1000` | sans cadence, un VU brûle 10 000 caractères en 45 s |
| plusieurs jetons | le crédit est **par e-mail**, pas par connexion |

Séquence minimale, à la main :

```bash
# 1. jeton de session, puis ticket WebSocket (réponse 201)
TICKET=$(curl -s -X POST "$API/api/ws-ticket" \
  -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d "{\"documentId\":\"$DOC\"}" \
  | python3 -c 'import json,sys; print(json.load(sys.stdin)["ticket"])')

# 2. état initial : seq + état Yjs complet
curl -s "$API/api/documents/$DOC/state" -H "authorization: Bearer $TOKEN"

# 3. ouverture
#    ws://13.53.160.209/ws?ticket=$TICKET&documentId=$DOC
#    → {"type":"joined", "seq":142, "creditRemaining":10000, …}
#    → envoi  {"type":"join","documentId":"$DOC","sinceSeq":142}
#    → reçu   {"type":"joined","seq":142,"caughtUp":0}
#    → envoi  {"type":"update","opId":"op_1","documentId":"$DOC","payload":"<Base64>"}
#    → reçu   {"type":"update","seq":143,…}  puis  {"type":"ack","opIds":["op_1"],…}
```

Vérification de la convergence du **contenu** (ce que k6 ne sait pas faire) :

```bash
node tests/node/verify-convergence.mjs \
  --api=$API/api --token=$TOKEN --doc=$DOC
# → {"seqContigus": true, "trous": 0, "reconstructionStable": true,
#    "verdict": "CONVERGENCE OK"}
```

---

## 9. Tableau récapitulatif des routes

### Routes du rédacteur (`/api`, JWT obligatoire sauf mention)

| Méthode | Chemin | Auth | Succès | Rôle |
| - | - | - | - | - |
| `POST` | `/api/session` | — | 200 | crée une identité, renvoie le jeton et le crédit |
| `GET` | `/api/config` | — | 200 | réglages publics (`creditPerDay`, `maxUpdateBytes`, …) |
| `GET` | `/api/me/credit` | JWT | 200 | état du crédit du jour |
| `GET` | `/api/documents` | JWT | 200 | documents dont on est membre |
| `POST` | `/api/documents` | JWT | 201 | crée un document |
| `GET` | `/api/documents/{id}` | JWT + membre | 200 | détail + membres |
| `GET` | `/api/documents/{id}/state` | JWT + membre | 200 | état Yjs compacté + `seq` |
| `GET` | `/api/documents/{id}/updates?since=` | JWT + membre | 200 | journal (pages de 500) |
| `POST` | `/api/documents/{id}/updates` | JWT + membre | 200 | repli HTTP d'écriture |
| `POST` | `/api/documents/{id}/members` | JWT + membre | 200 | ajoute un rédacteur |
| `GET` | `/api/documents/{id}/versions` | JWT + membre | 200 | 100 dernières versions |
| `POST` | `/api/documents/{id}/versions` | JWT + membre | 201 | enregistre une version |
| `POST` | `/api/documents/{id}/versions/{n}/restore` | JWT + membre | 200 | restaure (gratuit) |
| `POST` | `/api/documents/{id}/links` | JWT + membre | 201 | crée un lien à quota N |
| `GET` | `/api/documents/{id}/links` | JWT + membre | 200 | liens du document |
| `POST` | `/api/ws-ticket` | JWT + membre | **201** | ticket WebSocket (60 s, usage unique) |

### Parcours visiteur (`/`, aucune authentification)

| Méthode | Chemin | Succès | Rôle |
| - | - | - | - |
| `GET` | `/d/{token}/status` | 200 | `active` ou `exhausted`, **ne consomme pas** |
| `POST` | `/d/{token}/claim` | 200 / 202 / 410 | réserve un exemplaire, idempotent par `visitorId` |
| `GET` | `/d/{token}/file?visitorId=` | 200 / 202 / 410 | reprend un téléchargement déjà réservé |

### Supervision et exploitation

| Méthode | Chemin | Auth | Succès | Rôle |
| - | - | - | - | - |
| `GET` | `/api/admin/state` | `X-Admin-Key` | 200 | documents ouverts, liens actifs, blocages |
| `GET` | `/health` | — | 200 | `{status, uptime, mode}` |
| `GET` | `/ws` | ticket | 101 | WebSocket applicatif |
| `GET` | `/api/__internal/tables` | — | 200 | diagnostic : nombre de lignes par table |

> `GET /api/__internal/tables` ne renvoie aucun contenu métier (uniquement des
> compteurs) et sert au mode local et aux tests. C'est néanmoins une route de
> diagnostic exposée : elle est à retirer ou à protéger si le service devait
> sortir du cadre du projet.

### Routes absentes, à connaître

| Attendu | État | Contournement |
| - | - | - |
| `DELETE /links/{token}` (révocation) | **non implémenté** | quota épuisé, ou lien de remplacement |
| `DELETE /documents/{id}/members` | **non implémenté** | partage additif uniquement |
| message WebSocket `resync` | **n'existe pas** | `join` avec `sinceSeq`, ou `/updates?since=` |
| rafraîchissement de jeton | **non implémenté** | refaire `POST /api/session` (7 jours) |
