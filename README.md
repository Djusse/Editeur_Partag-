# Éditeur de documents partagé

Application web d'écriture collaborative sur AWS : plusieurs centaines de rédacteurs
travaillent en temps réel sur le même texte, et un **lien de téléchargement à quota
strict** distribue le document en PDF, tel qu'il est au moment où le visiteur s'en sert.

**Auteur :** Djusse Tameno Christian — 5e année Génie informatique, ENSPY
**Cours :** Cloud (5 jours × 8 h) — projet d'évaluation individuel

---

## 1. Ce que fait l'application

| Fonction | Comportement |
| - | - |
| Écrire à plusieurs | Fusion **CRDT (Yjs)** : aucune modification acceptée n'est perdue, tous les participants convergent, même en écrivant au même endroit |
| Présence | Liste des rédacteurs connectés et curseurs colorés |
| Versions | Historique de snapshots et restauration **compatible CRDT** (nouvel update, rien n'est effacé) |
| Partage | Ajout d'un rédacteur par e-mail |
| Lien de téléchargement | Quota choisi à la création ; **exactement** N exemplaires, jamais N+1 |
| PDF | Généré **à la demande**, à partir de la version figée au moment de la réservation (T1) |
| Crédit | 10 000 caractères par jour UTC et par e-mail, partagés entre tous les appareils ; 4 refus → blocage jusqu'au prochain minuit UTC |
| Supervision | Documents ouverts, liens actifs avec restants, personnes bloquées |
| Notification | E-mail au créateur lors du **dernier** exemplaire distribué |

### Les trois états du visiteur (jamais d'écran vide)

| État | HTTP | Sens |
| - | - | - |
| `ready` | 200 | Votre PDF est prêt, URL présignée valable 60 s |
| `waiting` | 202 + `Retry-After` | Votre exemplaire est réservé, le PDF se prépare |
| `exhausted` | 410 | Le lien a distribué tous ses exemplaires ; plus aucun calcul n'est fait |

---

## 2. Architecture

```
Navigateur (SPA Next.js export statique)
   │ HTTPS                      │ WSS (ticket à usage unique, 60 s)
   ▼                            ▼
CloudFront ── S3 (front)     API Gateway WebSocket
   │                            │  $connect / $default / $disconnect
   ├─ /api/* → API Gateway HTTP  │
   │            → Lambda REST    → Lambda WS ──┐
   │                                           ▼
   └────────────────────────────────────► DynamoDB (12 tables)
                                              │ Streams (Links)
                                              ▼
                                    Lambda notify → SES
Lambda pdf (asynchrone) → S3 privé (pdf/{docId}/v{seq}.pdf) → URL présignée 60 s
SSM Parameter Store : secret JWT, clé admin (générés au premier appel)
```

Une seule région : **`eu-west-3`** (Paris). Infrastructure entièrement décrite dans
[`infra/template.yaml`](infra/template.yaml) (AWS SAM).

Les décisions et leurs justifications sont dans [`docs/adr/`](docs/adr/) :

| ADR | Sujet |
| - | - |
| [001](docs/adr/001-calcul-lambda.md) | Calcul sur Lambda |
| [002](docs/adr/002-dynamodb.md) | DynamoDB à la demande et écritures conditionnelles |
| [003](docs/adr/003-temps-reel-websocket.md) | Temps réel : WebSocket + repli HTTP |
| [004](docs/adr/004-crdt-yjs.md) | Fusion par CRDT |
| [005](docs/adr/005-pdf-asynchrone.md) | PDF asynchrone et cache par version |
| [006](docs/adr/006-comptage-credit.md) | Comptage du crédit côté serveur |
| [007](docs/adr/007-montee-en-charge.md) | Montée en charge d'un document |

### Comment les deux contraintes éliminatoires tiennent

**C1 — exactement N téléchargements.** Le décrément de `remaining` et la création du
ticket sont dans **une seule** transaction DynamoDB conditionnelle
(`remaining > 0 AND status = ACTIVE`, `attribute_not_exists(visitorId)`). La transition
`ACTIVE → EXHAUSTED` est une écriture conditionnelle séparée (`status = ACTIVE AND
remaining = 0`), donc monotone et idempotente. Un visiteur se réserve **au claim**, pas au
téléchargement : réutiliser l'URL ne consomme rien de plus.

**C2 — aucune modification perdue.** Chaque update Yjs reçoit un `seq` **total et contigu**
dans la même transaction que sa persistance et son débit de crédit (5 éléments). Il ne
peut donc pas exister de trou, ni de crédit débité pour un update non écrit. Le client
rejoue les updates manquants à la reconnexion (`sinceSeq`).

---

## 3. Structure du dépôt

```
backend/          Bibliothèques pures + handlers Lambda (TypeScript)
  src/lib/        claim, crédit, updates, PDF, versions, JWT, DynamoDB, parseur Yjs
  src/handlers/   12 handlers : REST, WebSocket, PDF, notification SES
  test/           26 tests unitaires (Vitest) + double en mémoire de DynamoDB
frontend/         Next.js 14 en export statique (CodeMirror 6 + Yjs)
  src/app/        /, /documents, /doc, /d (visiteur), /admin
  src/lib/        client API et provider WebSocket Yjs maison
infra/            template.yaml (SAM) + samconfig.toml
tests/            k6 (S1, S2) et vérification de convergence en Node
docs/             ADR, journal, description d'API (OpenAPI + messages WebSocket)
scripts/          deploy.sh (infra → front → invalidation)
```

---

## 4. Prérequis

| Outil | Version | Rôle |
| - | - | - |
| Node.js | ≥ 20 | builds backend et frontend |
| npm | ≥ 9 | dépendances |
| AWS CLI | v2 | credentials, sorties de pile |
| AWS SAM CLI | ≥ 1.100 | déploiement |
| Docker | optionnel | DynamoDB Local (les tests unitaires n'en ont pas besoin) |
| k6 | ≥ 0.49 | tests de charge (optionnel) |

Compte AWS en plan gratuit, **une seule région**, avec un utilisateur IAM (jamais la racine).

### Adresse d'expédition SES

Le compte doit avoir une adresse **vérifiée** dans SES (bac à sable : seules les adresses
vérifiées reçoivent les e-mails). Vérifiez-la :

```bash
aws sesv2 create-email-identity --email-identity vous@gmail.com --region eu-west-3
aws sesv2 get-email-identity --email-identity vous@gmail.com --region eu-west-3
```

---

## 5. Déployer

### Commande unique (recommandée)

```bash
SES_SENDER="vous@gmail.com" ./scripts/deploy.sh
```

Le script enchaîne : dépendances → bundle backend → `sam deploy` → build du front avec les
URL réelles → envoi vers S3 → invalidation CloudFront → mise à jour de l'origine CORS.

À la fin, le terminal affiche les URL :

```
Front        : https://d111111abcdef8.cloudfront.net
API          : https://abc123.execute-api.eu-west-3.amazonaws.com
WebSocket    : wss://def456.execute-api.eu-west-3.amazonaws.com/prod
Bucket front : editeur-documents-front-123456789012
```

### Étape par étape

```bash
# 1. Backend (bundle esbuild, handlers autonomes)
cd backend
npm ci
npm run bundle

# 2. Infrastructure
cd ..
sam deploy \
  --template-file infra/template.yaml \
  --stack-name editeur-documents \
  --region eu-west-3 \
  --capabilities CAPABILITY_IAM \
  --resolve-s3 \
  --parameter-overrides SesSenderEmail=vous@gmail.com WebOrigin='*'

# 3. Front statique avec les URL réelles
API_URL=$(aws cloudformation describe-stacks --stack-name editeur-documents --region eu-west-3 \
  --query "Stacks[0].Outputs[?OutputKey=='ApiUrl'].OutputValue" --output text)
WS_URL=$(aws cloudformation describe-stacks --stack-name editeur-documents --region eu-west-3 \
  --query "Stacks[0].Outputs[?OutputKey=='WebSocketUrl'].OutputValue" --output text)
BUCKET=$(aws cloudformation describe-stacks --stack-name editeur-documents --region eu-west-3 \
  --query "Stacks[0].Outputs[?OutputKey=='FrontBucketName'].OutputValue" --output text)

cd frontend
NEXT_PUBLIC_API_BASE="$API_URL" NEXT_PUBLIC_WS_URL="$WS_URL" npm ci
NEXT_PUBLIC_API_BASE="$API_URL" NEXT_PUBLIC_WS_URL="$WS_URL" npm run build
aws s3 sync out "s3://$BUCKET" --delete --region eu-west-3

# 4. Invalidation
DIST_ID=$(aws cloudformation describe-stack-resource --stack-name editeur-documents \
  --region eu-west-3 --logical-resource-id FrontDistribution \
  --query StackResourceDetail.PhysicalResourceId --output text)
aws cloudfront create-invalidation --distribution-id "$DIST_ID" --paths '/*'
```

### Paramètres du template

| Paramètre | Défaut | Rôle |
| - | - | - |
| `SesSenderEmail` | — | **Obligatoire.** Adresse expéditrice vérifiée |
| `WebOrigin` | `*` | Origine CORS ; à restreindre à l'URL CloudFront |
| `CreditPerDay` | `10000` | Crédit quotidien par rédacteur |
| `MaxUpdateBytes` | `16384` | Plafond d'un update binaire |
| `PdfUrlTtlSeconds` | `60` | Durée de l'URL présignée |
| `SnapshotInterval` | `50` | Updates avant compaction en snapshot |

Aucun secret n'est dans le dépôt : le secret JWT et la clé admin sont **générés
automatiquement** dans SSM Parameter Store au premier appel (SecureString), puis mis en
cache par conteneur Lambda.

### Récupérer la clé d'administration

```bash
aws ssm get-parameter --name /editeur-documents/admin-key \
  --with-decryption --region eu-west-3 --query Parameter.Value --output text
```

---

## 6. Tester

### Tester en local, sans déployer

Un mode local exécute **les vrais handlers** avec DynamoDB en mémoire, S3 simulé
et PDF réellement généré. C'est la façon la plus rapide de vérifier C1, C3 et C4.

```bash
# Terminal 1 — API locale (affiche la clé admin)
cd backend && npm install && npm run dev:local

# Terminal 2 — interface
cd frontend && npm install && npm run dev:local
```

Ouvrir <http://localhost:3000>. Le statut affiché en éditeur est « Mode repli
HTTP » : le WebSocket n'existe pas en local, mais les updates empruntent le même
chemin serveur (même transaction, même crédit).

Ce qui **n'est pas** testable en local : le pic de charge (C5), le WebSocket et
les e-mails SES. Tout le détail, y compris le parcours de vérification de C1
pas à pas, est dans [`docs/developpement-local.md`](docs/developpement-local.md).

```bash
# Vérification automatisée du parcours (17 points), serveur local démarré
cd backend && node test-local.mjs
```

### Tests unitaires (aucun cloud requis)

```bash
cd backend
npm test
```

33 tests couvrent la logique critique :

| Fichier | Ce qui est prouvé |
| - | - |
| `test/yjs-update.test.ts` (7) | Comptage des caractères d'un vrai update Yjs : insertions, suppressions, update complet, unicode, update corrompu |
| `test/claim.test.ts` (8) | **C1** : N=10 exactement, retry idempotent, ticket renvoyé après épuisement, 50 claims simultanés pour N=20, version figée (T1), lien inconnu |
| `test/credit.test.ts` (11) | **C4** : débit exact, refus au-delà du plafond sans rien persister, partage entre appareils, `opId` rejoué, conflit d'`opId`, même contenu sous autre `opId`, suppressions facturées, séquence contiguë, restauration gratuite, blocage au 4ᵉ refus |
| `test/versions.test.ts` (7) | Restauration : remplacement sans duplication, version vide, document vide, préfixe/suffixe préservés, convergence, idempotence, retour exact à l'état d'origine |

### Vérifications de compilation

```bash
cd backend && npx tsc --noEmit
cd frontend && npx tsc --noEmit && npm run build
```

### Test manuel bout en bout

1. Ouvrir l'URL CloudFront, saisir un nom et un e-mail.
2. Créer un document, écrire du texte.
3. Ouvrir le même document dans un second navigateur (même e-mail) : la frappe apparaît
   dans les deux, la présence est visible.
4. Créer un lien avec `maxDownloads = 2`, ouvrir `/d?token=…` dans une fenêtre privée :
   premier visiteur `ready`, second `ready`, troisième `exhausted`.
5. Après le second téléchargement, vérifier la réception de l'e-mail (adresse vérifiée
   dans SES).

### Tests de charge

```bash
# S1 — C1 : 15 000 claims sur un lien de 500 exemplaires (80 % en 60 s)
k6 run -e API_URL="$API_URL" -e TOKEN="<token du lien>" -e MAX_DOWNLOADS=500 \
  --summary-export=tests/results/s1.json tests/k6/s1-claim.js

# S2 — C2 : N rédacteurs scriptés, tous au même index
k6 run -e API_URL="$API_URL" -e JWT="$JWT" -e DOC_ID="$DOC_ID" -e WRITERS=100 \
  --summary-export=tests/results/s2-100.json tests/k6/s2-convergence.js

# Vérification de convergence (séquences contiguës, empreinte stable)
node tests/node/verify-convergence.mjs --api="$API_URL" --token="$JWT" --doc="$DOC_ID"
```

> Un générateur de charge dans la **même région** (EC2 `t3.micro` ou CloudShell) mesure
> l'application, pas le réseau local.

---

## 7. Supprimer

```bash
aws s3 rm "s3://$(aws cloudformation describe-stacks --stack-name editeur-documents \
  --region eu-west-3 --query "Stacks[0].Outputs[?OutputKey=='FrontBucketName'].OutputValue" \
  --output text)" --recursive --region eu-west-3

aws s3 rm "s3://$(aws cloudformation describe-stacks --stack-name editeur-documents \
  --region eu-west-3 --query "Stacks[0].Outputs[?OutputKey=='PdfBucketName'].OutputValue" \
  --output text)" --recursive --region eu-west-3

sam delete --stack-name editeur-documents --region eu-west-3
```

### Vérifier que la suppression est complète

```bash
aws cloudformation describe-stacks --stack-name editeur-documents --region eu-west-3
# → "Stack with id editeur-documents does not exist"

aws s3 ls | grep editeur-documents            # → aucune ligne
aws dynamodb list-tables --region eu-west-3    # → aucune table du projet
aws lambda list-functions --region eu-west-3 \
  --query "Functions[?contains(FunctionName,'editeur-documents')].FunctionName"   # → []
```

> **Avant toute suppression** : exporter les résultats bruts (`tests/results/`) et les
> extraits CloudWatch ; les groupes de logs disparaissent avec la pile. Les paramètres SSM
> `/<stack>/*` sont supprimés avec la pile.

---

## 8. API

- [`docs/api/openapi.yaml`](docs/api/openapi.yaml) — API REST (OpenAPI 3.0), états
  visiteur, codes d'erreur.
- [`docs/api/websocket.md`](docs/api/websocket.md) — messages WebSocket, limites de
  taille, cycle de connexion.

---

## 9. Sécurité

- Aucune clé d'accès AWS dans le code ni dans l'historique Git ; secrets en SSM
  `SecureString`.
- Un rôle IAM **par fonction**, avec des ressources ciblées (pas de `*` sur les actions
  DynamoDB/S3).
- Buckets S3 : accès public bloqué, chiffrement AES256, accès par CloudFront **OAC** ou
  URL présignée de 60 s.
- Validation des entrées : e-mail, titre, longueur d'`opId`, plafond de 16 Ko binaire par
  update, corps JSON strict.
- Limitation de débit sur les deux API (rafale 500, 500 req/s).
- Journaux CloudWatch à rétention courte (`7 jours`) pour limiter le coût.
- Le JWT est porté par un en-tête `Authorization` ; le WebSocket utilise un ticket jetable
  de 60 s pour ne pas exposer le JWT dans l'URL.

**Limite assumée** : l'identité repose sur un simple e-mail saisi à l'entrée (le sujet
l'autorise). Quelqu'un qui connaît l'adresse d'un rédacteur peut s'y connecter. Une
authentification réelle (Cognito, lien magique) serait la prochaine étape.

---

## 10. Transparence

Conformément à l'esprit du sujet (« application simple, mais dont chaque choix est compris
et justifié ») et pour lever toute ambiguïté :

- Toutes les bibliothèques utilisées sont **open source** (Yjs, CodeMirror, pdf-lib,
  AWS SDK, Next.js).
- Un **assistant IA** a été utilisé pour la rédaction du code, des tests et de la
  documentation. Chaque décision d'architecture est justifiée dans les ADR et chaque
  affirmation sur les contraintes est adossée à un test exécutable
  (`backend/test/`), de sorte que le comportement peut être vérifié indépendamment de la
  manière dont le code a été produit.
- Les défauts trouvés par les tests et leurs corrections sont documentés dans
  [`docs/journal.md`](docs/journal.md).
