# Éditeur de documents partagé

Application web d'écriture collaborative sur AWS : plusieurs centaines de rédacteurs
travaillent en temps réel sur le même texte, et un **lien de téléchargement à quota
strict** distribue le document en PDF, tel qu'il est au moment où le visiteur s'en sert.

**Auteur :** Djusse Tameno Christian — 5e année Génie informatique, ENSPY
**Cours :** Cloud — projet d'évaluation individuel
**Région :** `eu-north-1` (Stockholm)

---

## 1. Architecture

```
Visiteurs / rédacteurs (navigateurs, k6)
        │  HTTP :80 — REST (/api) et WebSocket (/ws)
        ▼
Elastic IP ─► EC2 (Amazon Linux 2023, t3.large, crédits Standard)
              ├─ nginx : front statique, micro-cache de /status, proxy /api et /ws
              └─ Node.js 22 (systemd) : Fastify + ws + Yjs
                    • un seul écrivain par document (état en mémoire)
                    • claim, crédit, présence, tick d'écriture de 250 ms
                    │ rôle d'instance (identifiants temporaires, aucune clé)
      ┌─────────────┼───────────────┬───────────────┬──────────────┐
      ▼             ▼               ▼               ▼              ▼
  DynamoDB      S3 privé        SQS pdf-jobs      SES           SSM Parameter Store
  (10 tables)  (PDF, snapshots)  + lettres mortes  (dernier       (secret JWT,
                                                    exemplaire)    clé admin)
```

Une seule pile CloudFormation ([`infra/template.yaml`](infra/template.yaml)) :
EC2 + Elastic IP + Security Group, 10 tables DynamoDB, un bucket S3 privé, une file
SQS avec file de lettres mortes, un rôle d'instance de moindre privilège, un groupe
de journaux à rétention courte.

Les décisions sont justifiées une à une dans [`docs/adr/`](docs/adr/) :

| ADR | Sujet |
| - | - |
| [001](docs/adr/001-calcul-ec2.md) | Une instance EC2 plutôt que Lambda + API Gateway |
| [002](docs/adr/002-hub-ecrivain-unique.md) | Hub : écrivain unique, tick 250 ms, transaction atomique |
| [003](docs/adr/003-claim-gardememoire.md) | Claim : garde en mémoire + transaction conditionnelle |
| [004](docs/adr/004-crdt-yjs.md) | Fusion CRDT avec Yjs |
| [005](docs/adr/005-pdf-sqs.md) | PDF asynchrone (SQS), construit à la version figée |
| [006](docs/adr/006-credit-serveur.md) | Crédit : comptage serveur depuis le binaire Yjs |
| [007](docs/adr/007-front-http-sans-https.md) | Front statique servi par nginx, en HTTP sans domaine |

### Comment les deux contraintes éliminatoires tiennent

**C1 — exactement N téléchargements.** Le décrément de `remaining` et la création
du ticket sont dans **une seule** transaction conditionnelle
(`remaining > 0 AND status = ACTIVE`, `attribute_not_exists(visitorId)`).
La transition `ACTIVE → EXHAUSTED` est une écriture séparée et idempotente
(`status = ACTIVE AND remaining = 0`). Un exemplaire est consommé **au claim**, pas
au téléchargement du fichier : réutiliser l'URL ne consomme rien de plus.
Le ticket d'un `visitorId` est cherché **avant** le court-circuit `exhausted` : un
visiteur qui a déjà son exemplaire ne reçoit jamais `410`.

**C2 — aucune modification perdue.** Un seul écrivain par document : un tick de
250 ms écrit **un lot** dans une transaction atomique (`seq`, journal, crédit,
marqueurs `opId`/hash) et diffuse **un seul** message à tous. Un `ack` ne part
qu'après le commit ; un update non acquitté est renvoyé avec le **même** `opId`,
donc dédupliqué.

---

## 2. Structure du dépôt

```
backend/            Node.js 22 / TypeScript
  src/lib/          claim, crédit, comptage Yjs, PDF, versions, DynamoDB, S3, secrets
  src/realtime/     hub (écrivain unique), gestionnaire de documents, protocole ws
  src/routes/       routes Fastify (/api/* et parcours visiteur)
  src/server/       main.ts (Fastify + ws), worker.ts (SQS), app.ts (assemblage)
  src/local/        mode local sans AWS
  test/             42 tests unitaires (Vitest)
frontend/           Next.js 14 en export statique, thème clair
  src/app/          /, /documents, /doc, /d, /admin
  src/lib/          client API, provider Yjs, utilitaires (uuidv4, copyText)
  src/components/   TopBar, Modale, Toasts
infra/              template.yaml (CloudFormation) + README-infra.md
scripts/            deploy.sh
docs/               ADR, OpenAPI, spécification WebSocket, journal
tests/              k6 (S1, S2) et vérification de convergence
```

---

## 3. Prérequis

| Outil | Version | Rôle |
| - | - | - |
| Node.js | 22 | builds backend et frontend |
| AWS CLI | v2 ≥ 2.32 | `aws login` (aucune clé d'accès), déploiement |
| OpenSSL | — | génération des secrets SSM par `deploy.sh` |
| k6 | ≥ 0.49 | tests de charge (optionnel) |

Paire de clés SSH ED25519 pour l'accès à l'instance (facultative : `KEY_NAME=""`
déploie sans clé, l'accès passe alors par Session Manager), et une adresse
**vérifiée dans SES**.

SES doit être **sorti du bac à sable** pour prévenir n'importe quel destinataire.
L'usage déclaré est strictement transactionnel : un seul e-mail par lien de
téléchargement, au moment où le dernier exemplaire est distribué, à l'adresse de
la personne qui a créé le lien.

```bash
aws sesv2 create-email-identity --email-identity vous@gmail.com --region eu-north-1
aws sesv2 get-email-identity --email-identity vous@gmail.com --region eu-north-1
```

---

## 4. Déployer

```bash
KEY_NAME=cle-christian \
SES_SENDER="vous@gmail.com" \
ADMIN_CIDR="82.1.2.3/32" \
./scripts/deploy.sh
```

Le script :

1. vérifie l'identité AWS et la région ;
2. crée la paire de clés si elle manque, puis les secrets SSM
   `/editeur/jwt-secret` et `/editeur/admin-key` (jamais dans le dépôt) ;
3. déploie la pile CloudFormation ;
4. construit le backend (`tsc`) et le front (`next build`, export statique),
   archive le tout ;
5. envoie l'archive dans S3 puis demande à l'instance de l'installer via **SSM
   Run Command** (redémarrage de `editeur-app` et `editeur-worker`) ;
6. vérifie que `/health` répond et affiche la clé d'administration.

À la fin :

```
Application  : http://<elastic-ip>
Supervision  : http://<elastic-ip>/admin
```

### Paramètres du template

| Paramètre | Défaut | Rôle |
| - | - | - |
| `KeyName` | — | Paire de clés SSH existante |
| `AdminCidr` | `0.0.0.0/0` | Plage autorisée pour SSH (mettre votre IP en `/32`) |
| `InstanceType` | `t3.large` | Type d'instance, à ajuster **par la mesure** |
| `SesSenderEmail` | — | Adresse expéditrice vérifiée dans SES |
| `CreditPerDay` | `10000` | Crédit quotidien par rédacteur |
| `MaxUpdateBytes` | `65536` | Plafond d'un update binaire (64 Ko) |
| `BatchMs` / `TickMs` | `300` / `250` | Regroupement client / tick serveur |

---

## 5. Tester

### Tests unitaires (aucun cloud requis)

```bash
cd backend
npm install
npm test
```

42 tests couvrent la logique critique :

| Fichier | Ce qui est prouvé |
| - | - |
| `test/claim.test.ts` (11) | **C1** : N exact, 50 claims concurrents, idempotence, ticket renvoyé après épuisement, T1 figée, un seul job PDF par version |
| `test/credit.test.ts` (15) | **C4** : débit exact, plafond, multi-appareils, `opId` rejoué, contenu identique, suppressions facturées, séquence contiguë, restauration gratuite, blocage au 4ᵉ refus, isolation d'un refus dans un lot, jour métier à minuit heure de Douala, refus après blocage |
| `test/yjs-update.test.ts` (7) | Comptage sur de vrais updates Yjs : insertions, suppressions, update complet, unicode, update corrompu |
| `test/email.test.ts` (9) | **Notification** : envoi au seul dernier exemplaire, idempotence, panne SES sans impact sur le visiteur, relâchement du verrou, échappement HTML, pluriel |

### Tester en local, sans AWS

```bash
# Terminal 1 — serveur complet (Fastify + WebSocket + PDF réel)
cd backend && npm install && npm run local

# Terminal 2 — interface
cd frontend && npm install && npm run dev:local
```

Ouvrir <http://localhost:3000>. Contrairement à une architecture Lambda, le
**WebSocket natif fonctionne ici** : deux onglets convergent réellement, et le PDF
est généré puis téléchargé.

> **Ne lancez pas `npx next dev` directement.** Ce script définit
> `NEXT_PUBLIC_API_BASE=http://localhost:4000/api` et
> `NEXT_PUBLIC_WS_BASE=ws://localhost:4000/ws`. Sans ces variables, le client
> appelle `/api` sur le port 3000 — qui ne sert pas l'API — et l'interface affiche
> « Impossible de charger vos documents ».
>
> Si vous changez ces variables, arrêtez le serveur et supprimez `frontend/.next` :
> les valeurs `NEXT_PUBLIC_*` sont **inlinées dans le bundle** à la compilation,
> un cache périmé continuerait de servir les anciennes.

```bash
# Vérification automatisée du parcours (20 points), serveur local démarré
cd backend && node e2e-local.mjs

# Scénario d'épuisement du crédit (19 points) : C4 et sections 9.4 à 9.6
cd backend && node test-credit-exhaustion.mjs

# Le bundle client vise-t-il la bonne API ? (le serveur peut être sain et le
# client faux : c'est arrivé trois fois, voir le journal)
node tests/node/verify-client-bundle.mjs --dev
```

Ce qui n'est **pas** testable en local : le pic de charge (C5) et nginx. Le
parcours de notification est observable : le mode local n'appelle pas SES, il
journalise le message (`[e-mail local] à … — …`).

### Notification de fin de quota (SES)

Un lien distribue son **dernier** exemplaire → son créateur reçoit un e-mail
unique. Trois garanties, chacune couverte par [`test/email.test.ts`](backend/test/email.test.ts) :

| Garantie | Mécanisme |
| - | - |
| Un seul envoi | verrou `notified` posé de façon **conditionnelle** avant l'envoi ; seule la transition `false → true` envoie |
| Jamais d'échec visible pour le visiteur | `notifyLinkExhausted` ne lève pas : une panne SES est journalisée, le PDF déjà réservé reste servi |
| Nouvelle tentative possible | en cas d'échec d'envoi, le verrou est **relâché** — mieux vaut un doublon rare qu'un créateur jamais prévenu |

Le contenu est échappé (le titre et le nom sont saisis par l'utilisateur) et le
transport est injectable (`setMailer`), comme S3 et SQS : aucun test n'appelle AWS.

#### Outils de développement (mode local uniquement)

Le crédit est quotidien et un blocage dure jusqu'à la remise à zéro (minuit
**heure de Douala**, soit 23:00 UTC) : après avoir testé le scénario
d'épuisement, le compte reste bloqué pour la journée. Pour rejouer le parcours
sans attendre :

```bash
# Crédit et blocage d'une adresse
curl -X POST http://localhost:4000/__reset-credit \
  -H 'content-type: application/json' -d '{"email":"vous@exemple.cm"}'

# Toutes les adresses du jour
curl -X POST http://localhost:4000/__reset-credit
```

Ces routes ne sont enregistrées que par [`src/local/main.ts`](backend/src/local/main.ts:205) ;
`src/server/main.ts` (production) ne les connaît pas.

Le diagnostic complet est sur `GET http://localhost:4000/__debug` : clé
d'administration et nombre de lignes par table.

### Test manuel sur le déploiement

1. Ouvrir `http://<elastic-ip>`, saisir un nom et un e-mail.
2. Créer un document, écrire ; ouvrir dans un second navigateur : la frappe arrive
   dans les deux et la présence apparaît.
3. Créer un lien à 2 exemplaires, ouvrir `/d?token=…` dans une fenêtre privée :
   « Prêt à réserver », puis « Patienter », puis « Prêt ». Le troisième onglet
   affiche « Ce lien est épuisé. ».
4. Rafraîchir après un téléchargement : le même visiteur retrouve son exemplaire,
   sans en consommer un autre.

### Tests de charge

```bash
# S1 — C1 : 15 000 claim sur un lien de 500 exemplaires (80 % en 60 s)
k6 run -e API_URL="http://<elastic-ip>" -e TOKEN="<token>" -e MAX_DOWNLOADS=500 \
  --summary-export=tests/results/s1.json tests/k6/s1-claim.js

# S2 — C2 : N rédacteurs scriptés, tous au même index
k6 run -e API_URL="http://<elastic-ip>" -e JWT="<jwt>" -e DOC_ID="<doc>" -e WRITERS=100 \
  --summary-export=tests/results/s2-100.json tests/k6/s2-convergence.js

node tests/node/verify-convergence.mjs --api="http://<elastic-ip>" --token="<jwt>" --doc="<doc>"
```

Le générateur de charge doit tourner **dans la même région** : la connexion locale
mesurerait le réseau, pas l'application.

---

## 6. Supprimer

```bash
./scripts/destroy.sh          # demande confirmation (« supprimer »)
./scripts/destroy.sh --yes    # sans confirmation
```

Un simple `aws cloudformation delete-stack` ne suffit pas :

- le bucket est **versionné** — `delete-stack` échoue tant qu'il contient des
  objets, et supprimer seulement les objets courants laisse les versions ;
- les paramètres SSM `/editeur/*` et la paire de clés sont **hors pile** et
  subsistent après la suppression.

Le script enchaîne donc : inventaire → purge du bucket (objets **et** versions,
marqueurs de suppression compris) → suppression de la pile et attente → secrets,
paire de clés et files SQS résiduelles → **vérification finale** (pile, instances,
Elastic IP, tables, buckets, files, paramètres, groupes de logs). Il se termine en
erreur s'il reste une ressource facturable.

> **Avant toute suppression** : exporter les résultats bruts (`tests/results/`) et
> les extraits CloudWatch. Les groupes de logs disparaissent avec la pile.

---

## 7. API

- [`docs/api/openapi.yaml`](docs/api/openapi.yaml) — REST, états visiteur, codes d'erreur.
- [`docs/api/websocket.md`](docs/api/websocket.md) — messages, plafonds, cycle de connexion.

---

## 8. Sécurité

- **Aucune clé d'accès** dans le code ni dans l'historique : `aws login` côté poste,
  rôle d'instance côté serveur (identifiants temporaires).
- Secrets en SSM `SecureString`, créés par `deploy.sh` — jamais dans le template, ni
  dans le user data (lisible via les métadonnées).
- **Moindre privilège** : rôle d'instance limité aux tables nommées, au préfixe S3,
  à la file SQS et à `ses:SendEmail` filtré sur l'expéditeur vérifié.
- **S3** : accès public bloqué, chiffrement AES256, versionnage, stratégie refusant
  le trafic non HTTPS, URL présignées de 60 s.
- **Security Group** : 80 ouvert, 22 limité à `AdminCidr`.
- **IMDSv2 obligatoire** (`HttpTokens: required`), crédits CPU en Standard.
- Validation des entrées : e-mail, titre (120), longueur d'`opId`, plafond 64 Ko par
  update, corps JSON strict.
- Ticket WebSocket à usage unique (60 s), pour ne pas exposer le JWT dans l'URL.
- Journaux à rétention courte (7 jours).

**Limites assumées** : HTTP sans TLS (jetons et e-mails en clair), instance unique
(pas de haute disponibilité), identité sans mot de passe. Chacune est argumentée dans
les ADR et reprise dans le dossier de conception.

---

## 9. Codes d'erreur

| Code | HTTP | Sens |
| - | - | - |
| `INVALID_INPUT` | 400 | Entrée invalide, champ indiqué dans `field` |
| `UNAUTHORIZED` | 401 | Session absente ou expirée |
| `FORBIDDEN` | 403 | Pas membre du document |
| `NOT_FOUND` | 404 | Document, version ou lien inconnu |
| `ALREADY_MEMBER` | 409 | Cette personne a déjà accès |
| `PAYLOAD_TOO_LARGE` | 413 | Update au-delà de 64 Ko |
| `CREDIT_EXHAUSTED` | 403 | Crédit du jour épuisé |
| `BLOCKED` | 403 | Écriture bloquée jusqu'à `blockedUntil` |
| `NO_TICKET` | 410 | Aucun exemplaire réservé pour ce visiteur |
| `PDF_UNAVAILABLE` | 503 | Génération impossible après 3 essais |

---

## 10. Transparence

- Toutes les bibliothèques utilisées sont **open source** (Yjs, CodeMirror, pdfkit,
  Fastify, `ws`, AWS SDK, Next.js).
- Un **assistant IA** a été utilisé pour la rédaction du code, des tests et de la
  documentation. Chaque affirmation sur les contraintes est adossée à un test
  exécutable (`backend/test/`) ou à un scénario de charge, de sorte que le
  comportement est vérifiable indépendamment de la façon dont le code a été produit.
- Les défauts trouvés en cours de route et leurs corrections sont consignés dans
  [`docs/journal.md`](docs/journal.md).
