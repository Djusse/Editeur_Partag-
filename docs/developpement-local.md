# Développement et test en local (sans AWS)

Le projet peut être exercé **sans compte AWS**. C'est utile pour développer
l'interface, vérifier les contraintes C1 et C4 à la main, et déboguer sans
attendre un déploiement.

## Ce qui tourne réellement

Le serveur local [`backend/src/dev/server.ts`](../backend/src/dev/server.ts)
exécute **les vrais handlers déployés** (`backend/src/handlers/*`), c'est-à-dire
exactement ceux que le template SAM référence. Seules trois dépendances sont
substituées :

| Dépendance AWS | Substitution locale |
| - | - |
| DynamoDB | double en mémoire ([`memory-dynamo.ts`](../backend/test/helpers/memory-dynamo.ts)), le **même** que celui des tests unitaires |
| S3 | stockage en mémoire + route `/__files/*` pour les PDF |
| SSM Parameter Store | secrets générés en mémoire (JWT et clé admin **distincts**) |
| Lambda PDF | exécution directe de `buildPdfForVersion` en tâche de fond |

## Ce qui est donc vraiment testable

| Contrainte | Testable en local ? | Comment |
| - | - | - |
| **C1** — exactement N téléchargements | **Oui** | Créer un lien à 2 exemplaires, ouvrir `/d?token=…` trois fois |
| **C4** — crédit de 10 000 caractères | **Oui** | Écrire, puis `GET /me/credit` ; le compteur bouge |
| **C2** — aucune modification perdue | **Oui, en repli HTTP** | Deux fenêtres sur le même document : les updates passent par `POST /updates` |
| **C3** — PDF à la version T1 | **Oui** | Le PDF est réellement généré et téléchargeable |
| Versions / restauration | **Oui** | Boutons « Enregistrer une version » et « Restaurer » |
| Supervision | **Oui** | `/admin` avec la clé affichée au démarrage |
| **C5** — 15 000 visiteurs | **Non** | Pas d'API Gateway, pas de CloudFront, pas de limite de concurrence |
| WebSocket temps réel | **Non** | Le provider bascule automatiquement en repli HTTP |
| E-mail SES | **Non** | `notify` n'est jamais déclenché |

## Démarrer

Deux terminaux.

```bash
# Terminal 1 — API locale (port 4000)
cd backend
npm install
npm run dev:local
```

Le terminal affiche l'API, l'URL de diagnostic et **la clé d'administration** :

```
API         : http://localhost:4000
Diagnostic  : http://localhost:4000/__debug
Clé admin   : RuUQw4wRBhD2Shy2J81OEw
```

```bash
# Terminal 2 — interface (port 3000)
cd frontend
npm install
npm run dev:local
```

Ouvrir **http://localhost:3000**.

## Parcours de vérification manuelle

### 1. Créer un document

Saisir un nom et un e-mail → **Entrer dans l'éditeur** → créer un document
« Journal 2026 ». Écrire quelques lignes.

> Le statut affiché est **« Mode repli HTTP »** : c'est normal, il n'y a pas de
> WebSocket local. Le mecanisme est le même qu'en production lorsque le
> WebSocket est indisponible.

### 2. Vérifier C1 (le plus important)

1. Dans l'éditeur, mettre `2` dans le champ de quota puis **Créer le lien**.
2. Le lien est copié dans le presse-papiers (`http://localhost:3000/d?token=…`).
3. Ouvrir ce lien dans une fenêtre de navigation privée → **Patientez** puis
   **Télécharger le PDF** (le PDF est réellement généré).
4. Rafraîchir la page : le même visiteur retrouve **son** PDF, sans consommer
   un second exemplaire.
5. Ouvrir le lien dans une **autre** fenêtre privée → second exemplaire.
6. Ouvrir dans une **troisième** → **« Lien épuisé »** (410).
7. Revenir sur la première fenêtre et rafraîchir → toujours `ready` : le ticket
   existant est renvoyé même après épuisement.

### 3. Vérifier C4

Dans l'éditeur, la barre de crédit diminue à chaque frappe. Pour forcer le
plafond, abaisser la limite en démarrant le serveur avec :

```bash
CREDIT_PER_DAY=20 npm run dev:local
```

Au-delà, l'interface passe en lecture seule et affiche le message du serveur.

### 4. Vérifier C3 (PDF à la version figée)

1. Créer un lien à 2 exemplaires.
2. Réserver un exemplaire (le PDF est généré).
3. Modifier encore le document.
4. Télécharger à nouveau depuis la même fenêtre : le PDF correspond à la
   version **réservée**, pas au texte courant.

### 5. Supervision

Ouvrir **http://localhost:3000/admin** et coller la clé affichée au démarrage du
serveur. On voit les documents ouverts, les liens et leur reste, les crédits
consommés et les personnes bloquées.

## Diagnostic

```bash
# État des « tables » en mémoire et clé admin
curl -s localhost:4000/__debug | head -30

# Créer une session et appeler l'API directement
TOKEN=$(curl -s -X POST localhost:4000/session \
  -H 'content-type: application/json' \
  -d '{"name":"Awa","email":"awa@exemple.cm"}' | node -pe "JSON.parse(require('fs').readFileSync(0,'utf8')).token")

curl -s localhost:4000/me/credit -H "authorization: Bearer $TOKEN"
```

## Vérification automatisée de bout en bout

[`backend/test-local.mjs`](../backend/test-local.mjs) exerce 17 points du
parcours (session, document, écriture, idempotence, crédit, reconstruction CRDT,
lien, claim, épuisement, PDF réel, versions, supervision, contrôle d'accès) :

```bash
cd backend
npm run dev:local          # terminal 1
node test-local.mjs        # terminal 2
```

Résultat attendu :

```
=== 17 OK, 0 FAIL ===
```

## Limites assumées

- Les données sont **perdues** à l'arrêt du serveur (mémoire uniquement).
- Pas de WebSocket : la convergence est testée par le chemin de repli HTTP, qui
  applique **les mêmes** règles serveur (même transaction, même crédit).
- Aucune limite de débit, aucune concurrence Lambda, aucun CloudFront : le mode
  local ne dit **rien** sur C5.
- La clé admin change à chaque redémarrage.

## Défauts révélés par ce mode local

Ce mode a servi de test réel, et a mis au jour trois défauts qui auraient cassé
le déploiement :

1. **Le template appelait des fonctions internes** (`documents.listHandler`,
   `links.createHandler`…) et non des handlers Lambda : les bundles n'exposaient
   pas ces noms, donc **toutes les routes HTTP** auraient échoué en production.
   Correction : chaque fichier exporte désormais des handlers wrappés
   (`httpHandler(...)`), et le template les référence.
2. **`POST /documents`, `PATCH` et `DELETE` partageaient le handler de `GET`** :
   la création d'un document aurait répondu comme une lecture. Correction :
   trois fonctions distinctes.
3. **Le provider bloquait toute écriture** quand le WebSocket n'était pas
   connecté (`synced` faux) : en repli HTTP, aucune modification ne partait.
   Correction : le repli est activé immédiatement, sans dépendre de `synced`.
