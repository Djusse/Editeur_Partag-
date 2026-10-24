# Plan d'exécution — Éditeur de documents partagé (AWS, EC2)

**Auteur :** Djusse Tameno Christian — 5e année Génie informatique, ENSPY
**Cours :** Cloud — Projet d'évaluation individuel
**Version :** v7 — samedi 24/10/2026, 16h00
**Fenêtre de travail :** samedi 16h00 → lundi **08h00** (délai ferme : tout le code sur GitHub, aucune modification acceptée ensuite) ; dernier push à **07h30**. Travail effectif réaliste : ≈ 30 h (sommeil et repas déduits).
**Région :** `eu-north-1` (Stockholm), imposée par le compte
**Stack :** une instance EC2 (Node.js 22 / TypeScript : Fastify + `ws` + Yjs) derrière nginx, DynamoDB, S3, SQS, SES, SSM Parameter Store, CloudFormation

## 0. Ce qui change par rapport à la v6
- **Calcul : EC2 au lieu de Lambda + API Gateway.** Le cours a couvert EC2 (TP 3 et 4), pas Lambda, API Gateway ni SAM. L'état en mémoire d'un seul processus supprime l'essentiel des difficultés des 300 rédacteurs dans un même document.
- **Quotas mesurés dans le compte (eu-north-1) :** concurrence Lambda **400**, quota de vCPU EC2 (familles A, C, D, H, I, M, R, T, Z) **16**. Le serverless restait possible mais serré (les visiteurs qui patientent consomment de la concurrence) ; EC2 a de la marge. À citer dans l'ADR.
- **Région `eu-north-1`** (et non Paris), connexion par `aws login` sans clé d'accès, pas d'utilisateur root.
- **Supprimés :** API Gateway WebSocket, Base64 imposé par le service, file SQS FIFO par document, lots `commitBatch` via SQS, CloudFront obligatoire.
- **Conservés :** transactions DynamoDB (claim, crédit), idempotence, T1, versions, URLs présignées, scénarios de test, livrables, décisions du tableau 1.4.

---

## 1. Analyse du sujet

### 1.1 Ce que le jury évalue
Le sujet le dit : le choix de l'architecture, des services et des technologies revient à l'étudiant, et c'est l'essentiel de l'évaluation. « Une application simple, mais dont chaque choix est compris et justifié, vaut mieux qu'une application complexe que vous ne savez pas expliquer. » Les contraintes 1 et 2 sont éliminatoires : une application rapide qui ne les respecte pas est non fonctionnelle.

### 1.2 Les 6 contraintes → réponse retenue

| # | Contrainte | Réponse retenue |
|---|-----------|-----------------|
| C1 | Exactement N téléchargements, jamais N+1 | Transaction DynamoDB : décrément de `remaining` (condition `remaining > 0`) + création du ticket. Une garde en mémoire du processus allège DynamoDB mais **n'est jamais l'autorité** |
| C2 | Aucune modification acceptée perdue, convergence | Yjs (CRDT) + **écrivain unique par document** ; une modification n'est acquittée qu'**après** écriture durable dans le journal DynamoDB |
| C3 | Document tel qu'il est à T1, complet et cohérent | Le claim fige un `seq` (T1 = lecture de `seq` au début du claim) ; PDF construit depuis le journal jusqu'à ce `seq`, généré une fois par version, de façon asynchrone |
| C4 | Jamais plus que son crédit, même multi-appareils | Compteur DynamoDB par (e-mail, jour UTC) débité dans la **même transaction** que l'écriture au journal ; comptage côté serveur |
| C5 | 15 000 clics (80 % en 60 s) + 300 rédacteurs | nginx avec micro-cache sur `/status`, garde en mémoire, transactions en vol limitées, diffusion par ticks, instance dimensionnée **par la mesure** ; trois états explicites : prêt / patienter / épuisé |
| C6 | Dernier exemplaire : visiteurs prévenus vite, plus de travail inutile | État `EXHAUSTED` monotone : réponse immédiate depuis la mémoire, aucun appel DynamoDB ; mis en cache longtemps par nginx |

### 1.3 Points d'attention
- **« Ni casser, ni jeter »** : chaque visiteur reçoit un des 3 états, jamais d'erreur brute (ni 429, ni timeout nu).
- **Instance unique = pas de haute disponibilité.** Le cours dit qu'il faut le savoir et le dire. Parades : redémarrage automatique (systemd), état reconstruit depuis DynamoDB, pistes d'évolution documentées.
- **L'adresse IPv4 publique change après un arrêt/démarrage** (cours, TP 3) : **Elastic IP** obligatoire pour que le jury teste une URL stable.
- **Pas de nom de domaine → pas de HTTPS direct** (le certificat ACM exige un domaine). Limite documentée. CloudFront devant l'instance donnerait du HTTPS : optionnel, en fin de parcours seulement.
- **Instances `t3` à crédits CPU** : en mode Standard (cours), l'instance est bridée quand les crédits sont épuisés. Surveiller `CPUCreditBalance` pendant les tests ; changer de type si besoin (arrêt, modification du type, redémarrage).
- **Descripteurs de fichiers** : plus de 12 000 connexions ouvertes imposent `LimitNOFILE` (systemd) et `worker_rlimit_nofile` (nginx).
- **Pas de secret dans le user data** (lisible via le service de métadonnées, cours TP 3) : secrets dans SSM Parameter Store.
- **SES en bac à sable** : aucun e-mail pour le jury tant que l'accès production n'est pas accordé ; expéditeur : ton adresse Gmail vérifiée.
- **Retries et doublons** : une réponse perdue puis un retry ne doivent ni consommer un 2e exemplaire (`visitorId`) ni débiter deux fois le crédit (`opId`).
- **Données de facturation en retard d'environ 24 h** : la preuve de coût combine captures et calcul à partir des métriques d'usage.
- **Règle « Travail individuel »** tronquée dans le sujet : bibliothèques open source autorisées (réponse reçue) ; l'usage d'un assistant IA est jugé implicitement autorisé (interprétation non confirmée) → **déclaré dans le README**.

### 1.4 Décisions et hypothèses (validées par toi ; **aucune n'est confirmée par le professeur**)
À reprendre dans le dossier de conception, marquées « hypothèse ».

| Sujet | Décision |
|-------|----------|
| Consommation d'un exemplaire | Au clic qui réserve le téléchargement (claim) |
| T1 | Le clic : lecture de `seq` au début du claim |
| Crédit | 10 000 caractères/jour : insertions **et** suppressions comptées ; restauration de version gratuite |
| Recharge | Minuit UTC |
| Blocage | 4 refus pour crédit épuisé dans la journée UTC → écriture bloquée jusqu'au prochain minuit UTC (lecture possible) |
| Pic d'écriture | 300 rédacteurs dans le **même** document (pire cas, interprétation) ; le palier réellement atteint est rapporté |
| Test du jury | Deux cas : URL déployée (Elastic IP) et redéploiement depuis le dépôt (README) |
| Livrables | Markdown, français, dépôt GitHub **privé** (jury ajouté en collaborateur) |
| Interface | Fonctionnelle, simple, moderne |
| E-mail | Gmail vérifié comme expéditeur SES ; si l'accès production est refusé, démonstration avec adresses vérifiées, documentée |
| Échéance | Lundi 08h00 ; dernier push 07h30 |

---

## 2. Architecture (une région, une instance applicative)

```
Visiteurs / rédacteurs (navigateurs, k6)
        │  HTTP :80 (REST et WebSocket)
        ▼
Elastic IP ─► EC2 (Amazon Linux 2023, VPC par défaut, sous-réseau public)
              │  Security Group : 80 ouvert ; 22 réservé à ton IP /32 (ou Session Manager)
              ├─ nginx : front statique (Next.js export), micro-cache de /status, proxy /api et /ws
              └─ Node.js (systemd) : Fastify (REST) + ws (WebSocket) + Yjs
                    • un seul écrivain par document (état en mémoire)
                    • claim, crédit, présence, worker PDF (worker thread)
                    │  rôle d'instance (identifiants temporaires, jamais de clé)
      ┌─────────────┼───────────────┬───────────────┬──────────────┐
      ▼             ▼               ▼               ▼              ▼
  DynamoDB     S3 privé        SQS pdf-jobs       SES        SSM Parameter Store
  (tables)    (PDF, snapshots,  + file de       (e-mail du    (secret JWT, clé
               artefacts)       lettres mortes   dernier        admin)
                                                 exemplaire)

Poste de charge : une 2e instance k6 dans la même région, allumée seulement pendant les tests.
```

### 2.1 Choix et justifications (un ADR par ligne)

| Sujet | Choix | Justification | Alternative écartée |
|-------|-------|---------------|---------------------|
| Calcul | **Une instance EC2**, Node.js 22 / TypeScript | Vu en cours (TP 3 et 4 : rôle d'instance, Security Group, user data). Un processus unique détient chaque document en mémoire : écrivain unique, diffusion locale, aucune contention de séquence. Quotas mesurés : 16 vCPU | **Lambda + API Gateway** : quota de concurrence 400 partagé entre claims, polling et écritures ; WebSocket API Gateway sans binaire, trame 32 Ko, un appel par destinataire ; services non vus en cours. **Spring Boot** : pas de bibliothèque Yjs côté serveur |
| Dimensionnement | Départ en `t3.large` (2 vCPU, 8 Gio), crédits **Standard** | Démarche du cours : taille modeste, mesurer, ajuster | Grosse instance d'emblée : coût inutile |
| Reverse proxy | nginx (TP 3) | Sert le front, micro-cache de `/status`, proxy WebSocket | Node seul : tout le trafic de polling passe par le processus applicatif |
| Temps réel | WebSocket natif (`ws`), messages JSON avec update Yjs en Base64 ; repli HTTP | JSON : le jury écrit son test sans protocole binaire. Le repli HTTP garde Yjs, donc C2 | y-websocket tel quel : ne gère ni crédit, ni journal atomique |
| Fusion | Yjs (`Y.Text`) | Convergence sans verrou ni perte | OT maison : trop risqué |
| Base | DynamoDB à la demande | Transactions conditionnelles (C1, C4), TTL, pas de serveur | RDS : facturé à l'heure, sans besoin relationnel |
| Fichiers | S3 privé, accès public bloqué, chiffrement, stratégie « HTTPS uniquement », URLs présignées de 60 s | Bonnes pratiques du cours (TP 4) | Bucket public : interdit |
| File | SQS standard + file de lettres mortes pour les PDF | Vu en cours : lisse la charge, consommateur idempotent, long polling | Génération dans la requête : timeout |
| E-mail | SES, expéditeur Gmail vérifié | Imposé par le sujet | — |
| Secrets | SSM Parameter Store (SecureString) | Pas de secret dans le code ni le user data | Variables dans le user data : lisibles via les métadonnées |
| IaC | **CloudFormation** (YAML) : `aws cloudformation deploy` / `delete-stack` | Répond au README « déployer, tester, supprimer » ; pas d'outil de plus à installer | SAM, CDK, Terraform : outils supplémentaires |
| Identité | JWT HS256 émis à l'entrée (nom + e-mail) ; ticket WebSocket à usage unique de 60 s | Suffisant selon le sujet ; limite documentée | Cognito : hors périmètre |
| Front | Next.js en **export statique** servi par nginx, CodeMirror 6 + `y-codemirror.next` | Next.js déjà maîtrisé ; routes par query string (`/doc?id=…`, `/d?token=…`) | Next.js SSR : un serveur de plus |
| Accès administrateur | SSH par paire de clés, limité à ton IP /32 ; **Session Manager** en repli si ton IP change | Vus en cours | Port 22 ouvert à tous : interdit |
| Haute disponibilité | **Non** (assumé) | Le cours demande de le savoir et de le dire | — |

### 2.2 Modèle de données DynamoDB

| Table | Clé | Contenu |
|-------|-----|---------|
| `Documents` | `docId` | titre, propriétaire, membres, `seq` (dernier journal écrit), `latestSnapshotSeq` |
| `Updates` | `docId` + `seq` | update Yjs fusionné d'un groupe (stocké en binaire), liste (`opId`, auteur, nb de caractères) ; `seq` **contigus** |
| `Credits` | `email#YYYY-MM-DD(UTC)` | `used`, TTL 48 h |
| `OpIds` | `OP#email#opId` et `HASH#docId#sha256` (deux éléments distincts) | `OP#` stocke `hash` et `seq` ; `HASH#` stocke `seq` ; TTL 48 h |
| `Abuse` | `email#YYYY-MM-DD(UTC)` | refus du jour, `blockedUntil` (prochain minuit UTC), TTL 48 h |
| `Links` | `token` | `docId`, créateur, `maxDownloads`, `remaining`, `status`, `notified` |
| `Tickets` | `token` + `visitorId` | `seqFigée`, état PDF, horodatage |
| `PdfCache` | `docId#seq` | état (BUILDING / READY), clé S3, horodatage du bail |
| `Versions` | `docId` + `n` | clé S3 du snapshot, auteur, date |

La présence, les connexions et les tickets WebSocket restent **en mémoire** (instance unique) : pas de table `Connections`.

### 2.3 Algorithmes critiques

**Claim d'un téléchargement (C1, C3, C5, C6)**
1. Le visiteur génère un `visitorId` aléatoire : un retry renvoie **le même ticket**.
2. `GET /d/{token}/status` : réponse depuis la mémoire ; nginx la met en micro-cache 1 s (`active`) ou longtemps (`exhausted`, via `X-Accel-Expires`). Le client fait du polling avec `Retry-After` et gigue.
3. `POST /d/{token}/claim` :
   - a. Lien `exhausted` en mémoire → `410` immédiat, aucun appel DynamoDB (C6).
   - b. `GetItem` du ticket `(token, visitorId)` : s'il existe, le renvoyer (même quota épuisé).
   - c. **Garde mémoire** : décrémente de façon synchrone un compteur local de jetons ; sans jeton, réponse `waiting` si des réservations sont en vol, `exhausted` sinon. Les jetons d'une transaction échouée sont rendus.
   - d. `seqFigée` = dernier `seq` écrit du document (mémoire, sinon `GetItem`). **T1 = cet instant.** Aucune condition sur ce `seq` dans la transaction (le document change en continu).
   - e. `TransactWriteItems` : `Links.remaining -= 1` (condition `remaining > 0`) **+** `Tickets` Put avec `seqFigée` (condition `attribute_not_exists`). Au plus ~50 transactions en vol.
   - f. Transaction annulée : relire le ticket (réponse perdue) ; sinon `exhausted`. Conflit ou throttling → retry avec backoff et gigue, nombre borné ; jamais d'erreur brute vers le visiteur.
4. PDF : si `PdfCache(docId#seqFigée)` est `READY` → URL présignée de 60 s ; sinon un seul message SQS (put conditionnel `BUILDING`) et **tous** reçoivent `202 waiting` + `Retry-After` ; ils font du polling sur `/file`.
5. Dernier exemplaire : le processus marque le lien `EXHAUSTED` ; l'e-mail est envoyé hors du chemin critique (mise à jour conditionnelle `notified`) ; un balayeur périodique rattrape un envoi manqué après plantage.

> Un exemplaire est consommé au **claim**, pas au téléchargement du fichier. Choix de conception à documenter.

**Écriture d'un update (C2, C4)** — écrivain unique par document
1. Le client regroupe les frappes (`BATCH_MS`, 300 ms par défaut, 1 s sous forte charge) et envoie `{type:"update", opId, documentId, payload (Base64)}` (≤ 64 Ko). Un update non acquitté reste dans une file locale et est renvoyé avec le **même** `opId`.
2. Le serveur vérifie l'accès et l'absence de blocage, décode l'update (`Y.decodeUpdate`) et compte les caractères **insérés et supprimés** (longueur des plages du delete set), quel que soit le `clientID` (le `clientID` n'est pas une preuve d'identité). Il met l'update en attente.
3. **Tick du document (250 ms)** : les updates en attente sont répartis en groupes (≤ ~30 expéditeurs, ≤ 95 éléments par transaction). Pour chaque groupe, une `TransactWriteItems` **sur éléments tous distincts** :
   - `Documents[docId]` : `SET seq = :s+1`, condition `seq = :s` (garde contre un second processus ; aucun conflit attendu avec un écrivain unique) ;
   - `Updates[docId, s+1]` : Put (condition `attribute_not_exists`), updates du groupe fusionnés (`Y.mergeUpdates`) ;
   - par expéditeur : `Credits[email#jour]` `ADD used :n` (condition `used + :n <= 10000`) ;
   - par update : `OpIds[OP#…]` et `OpIds[HASH#…]` (condition `attribute_not_exists`).
   Tout réussit ou rien n'est appliqué : pas de trou de `seq`, pas de crédit débité pour un update non persisté, pas de marqueur sans update.
4. `CancellationReasons` : crédit refusé → l'expéditeur est retiré du groupe, reçoit `CREDIT_EXHAUSTED` et la transaction est relancée (essais bornés) ; `OP#` ou `HASH#` déjà présent → `ack` d'origine (`seq` lu dans le marqueur), sans débit ; même `opId` avec un hash différent → rejet ; erreur DynamoDB transitoire → retry avec gigue.
5. Succès : l'update est appliqué au `Y.Doc` en mémoire, puis **un seul message fusionné** est diffusé aux clients (un par tick) et `ack {opIds, seq}` aux expéditeurs.
6. **Blocage** : chaque refus pour crédit épuisé incrémente `Abuse[email#jour]` (un même `opId` rejoué compte une fois) ; au 4e refus de la journée UTC → `blockedUntil` = prochain minuit UTC ; toute écriture d'un utilisateur bloqué reçoit `BLOCKED`.
7. Après `CREDIT_EXHAUSTED` ou `BLOCKED`, le client repasse en lecture seule et cesse d'envoyer (sinon il se bloquerait seul).
8. Insertions et suppressions consomment du crédit ; la restauration de version (update appliqué par le serveur) est gratuite.
9. Rattrapage : `join {documentId, sinceSeq}` ; les `seq` étant contigus, un trou est anormal et détectable ; resynchronisation par state vector toutes les 30 s en filet de sécurité.
10. **Redémarrage du processus** : état reconstruit depuis le dernier snapshot et le journal ; les clients renvoient les updates non acquittés (même `opId`, donc dédupliqués).

**Présence** : l'état (nom, couleur, position) reste en mémoire, diffusé par lots toutes les 500 ms ; au-delà de ~100 participants, les curseurs sont fusionnés à 1 s. Si `ws.bufferedAmount` d'un client dépasse un seuil, on lui coupe d'abord la présence, puis on le resynchronise.

**Versions** : snapshot dans S3 toutes les K entrées du journal et à la demande ; restauration = nouvel update qui remplace le texte (historique conservé).

**PDF (C3)** : le worker (SQS, long polling 20 s, délai de visibilité 120 s, file de lettres mortes après 3 essais) reconstruit le texte à l'état `seqFigée` (snapshot ≤ `seqFigée` + entrées du journal ≤ `seqFigée`), jamais depuis le texte courant ; `pdfkit` en worker thread ; clé S3 déterministe `pdf/{docId}/v{seq}.pdf`, donc idempotent.

---

## 3. Phasage d'exécution (samedi 16h00 → lundi 07h30)

### Phase 0 — Fondations (sam. 16h00 → 17h00)
- [x] Région du compte : `eu-north-1` ; quotas mesurés : concurrence Lambda 400, vCPU EC2 16 (à consigner dans `docs/journal.md` comme preuve de l'ADR)
- [ ] Double authentification dans AWS Settings ; connexion CLI par `aws login --profile cours` (aucune clé d'accès)
- [ ] **AWS Budgets** : alertes à 1 $ et 5 $ ; noter la date de début pour la preuve de coût
- [ ] **SES** : `aws sesv2 get-account --region eu-north-1` ; vérifier ton Gmail, envoyer un e-mail de test, demander l'accès production
- [ ] Dépôt GitHub **privé**, `.gitignore`, `gitleaks` avant le premier commit ; demander l'identifiant GitHub du jury (collaborateur en lecture)
- [ ] Poste : Node.js 22, AWS CLI v2 (≥ 2.32), Docker (DynamoDB Local), k6, Git
- [ ] Paire de clés `cle-christian` (ED25519) ; vérifier `t3.large` disponible à Stockholm
- [ ] Structure : `/infra`, `/backend`, `/frontend`, `/tests`, `/docs` ; ADR 1 à 3 (calcul, base, temps réel)

### Phase 1 — Socle et déploiement bout en bout (sam. 17h00 → 19h30)
- [ ] Template CloudFormation : bucket S3 (accès public bloqué, chiffrement, stratégie HTTPS, versionnage), tables DynamoDB, file SQS + lettres mortes, **rôle d'instance** de moindre privilège (ressources nommées, pas de `*`), Security Group, Elastic IP, instance (Amazon Linux 2023, `t3.large`, crédits Standard, IMDSv2 uniquement, tags `Proprietaire` et `Projet`, user data)
- [ ] Premier déploiement : page de test nginx (comme TP 3, étape 8), puis processus Node avec `/health` sous systemd (`Restart=always`, `LimitNOFILE`)
- [ ] `scripts/deploy.sh` : build, archive dans S3, mise à jour de l'instance, redémarrage du service
- [ ] **Test de reconstruction** : `delete-stack` puis redéploiement depuis le README
- [ ] `POST /session` (JWT, secret dans SSM), CRUD documents, partage par e-mail
- [ ] Front minimal Next.js (export statique) : entrée, liste, création

### Phase 1b — C1 en premier : liens à quota strict (sam. 19h30 → 22h30)
- [ ] `POST /documents/{id}/links`, `GET /d/{token}/status`, `POST /d/{token}/claim` (algorithme 2.3), `GET /d/{token}/file` (URL présignée d'un **PDF factice**)
- [ ] Garde mémoire, plafond de transactions en vol, retry avec gigue, micro-cache nginx
- [ ] Tests locaux (DynamoDB Local) : N=1, N=10, forte concurrence, retry avec le même `visitorId`
- [ ] Instance k6 (même région) : **S1 à petite échelle**, puis complet si possible ; résultats bruts archivés

### Phase 2 — Temps réel et convergence (sam. 22h30 → dim. 01h30) — cœur de C2
**Point de contrôle à 00h30** : si deux clients ne convergent pas encore, basculer sur le repli HTTP (`POST /updates` + `GET /updates?since=seq`, même chemin de transaction, Yjs conservé) et avancer. Une simple « sauvegarde + polling » qui écrase le texte violerait C2.
- [ ] Bibliothèque pure `commitGroup` (comptage, groupes, transaction, lecture des `CancellationReasons`) testée contre DynamoDB Local **avant** le déploiement
- [ ] `POST /ws-ticket` (usage unique, 60 s en mémoire), WebSocket : `join`, `update`, `awareness`, `ack`, `presence`, `error`
- [ ] Tick du document, diffusion fusionnée, rattrapage `sinceSeq`, reconstruction d'un document depuis le journal
- [ ] Front : CodeMirror + provider Yjs maison avec regroupement et file locale d'updates non acquittés, présence
- [ ] **Test de convergence** : 2 puis 10 clients scriptés au même endroit

*Sommeil : 01h30 → 08h00.*

### Phase 3 — Crédit et anti-abus (dim. 08h00 → 10h30)
Définir d'abord la règle métier (insertions **et** suppressions comptées ; restauration gratuite), puis coder, puis tester avant l'interface. Risque de planning important : prévoir une marge.
- [ ] Éléments `Credits` et `OpIds` (`OP#` et `HASH#`) dans la transaction d'écriture ; comptage serveur depuis le delete set ; plafond de taille ; mesure du coût CPU
- [ ] Blocage au 4e refus de la journée UTC, levé à minuit UTC (horloge injectable pour les tests) ; `GET /me/credit`
- [ ] Tests : 5 connexions simultanées ≤ 10 000 exactement ; renvoi du même `opId` débité une fois ; même contenu sous un autre `opId` sans débit ; même `opId` avec un contenu différent rejeté ; suppressions facturées ; restauration gratuite
- [ ] **S2 préliminaire** au palier 100 (30 min) pour détecter tôt un goulot

### Phase 4 — PDF réel, e-mail, statut (dim. 10h30 → 13h00) — C3, C5, C6
- [ ] Worker PDF (SQS, worker thread), cache par version, réponse `waiting` immédiate pour tous ; mesure sur petit et gros document (≥ 100 000 caractères)
- [ ] E-mail du dernier exemplaire (SES, `notified` conditionnel, balayeur de rattrapage)
- [ ] `Cache-Control` / `X-Accel-Expires` différents pour `active` et `exhausted`
- [ ] Page visiteur : trois états lisibles, polling avec `Retry-After` et gigue, jamais d'état vide

*Déjeuner : 13h00 → 14h00.*

### Phase 5 — Versions, supervision, interface (dim. 14h00 → 15h30)
- [ ] Snapshots, liste des versions, restauration
- [ ] `GET /admin/state` (clé dans SSM) : documents ouverts (mémoire), liens actifs avec exemplaires restants, personnes bloquées ; page simple
- [ ] Passe visuelle « moderne » sur le front

### Phase 6 — Tests de charge et preuves (dim. 15h30 → 20h30) — **à terminer avant 20h30**
Voir section 4. Surveiller `CPUCreditBalance`, la charge CPU, le retard de la boucle d'événements et les erreurs de throttling DynamoDB ; arrêter l'instance k6 à la fin.

### Phase 7 — Documents à rendre (dim. 20h30 → 00h30, puis lun. 06h00 → 07h30)
**Règle : documentation au fil de l'eau.** À la fin de chaque phase, 15 minutes pour l'ADR et les notes de test ; la phase 7 sert à assembler et relire.
- [ ] Dossier de conception, description de l'API, rapport de test, README (déployer / tester / supprimer, déclaration d'usage d'un assistant IA)
- [ ] **Avant toute suppression** : exporter dans `/tests/results/` les sorties k6, les métriques CloudWatch (CPU, réseau, crédits, throttling) et les extraits de journaux
- [ ] **Lundi 06h00 → 07h30** : captures de Billing (solde de crédits), Cost Explorer (peut être incomplet), calcul du coût à partir des métriques d'usage × tarifs publics, estimation avec le calculateur AWS ; tout commité avant **07h30** ; clone propre vérifié ; jury ajouté en collaborateur
- [ ] **Après le rendu** : ne pas supprimer l'infrastructure tant que le jury peut tester l'URL ; garder l'alerte de budget ; `delete-stack` seulement après correction

### Coupes possibles si le temps manque (dans cet ordre)
1. Curseurs distants élaborés (garder la liste de présence)
2. Page admin stylée (garder le JSON)
3. UI de restauration (garder l'endpoint et un test)
4. File SQS des PDF → file en mémoire (garder le bail `PdfCache`)
5. Palier de 300 rédacteurs : rapporter le palier réellement atteint
**Ne jamais couper :** C1, C2, C3, C4 et leurs preuves. HTTPS par CloudFront : seulement si tout est fini.

---

## 4. Stratégie de test et de preuve

### 4.1 Objectifs chiffrés (à ajuster après un premier essai)
| Mesure | Objectif |
|--------|----------|
| Téléchargements accordés vs autorisés | **exactement égaux** |
| Visiteurs sans état explicite (prêt / patienter / épuisé) | 0 ; timeouts, 5xx ou throttling éventuels sont mesurés et analysés |
| Latence `status` pendant le pic | p95 < 1 s |
| Délai d'information « épuisé » après le dernier exemplaire | < 5 s |
| Propagation d'une modification entre rédacteurs | p95 < 1 s (à 50 et 100 clients) |
| Écarts entre documents finaux des clients | 0 ; `seq` contigus |
| Palier de rédacteurs simultanés dans un même document | relevé (cible 300) |

### 4.2 Scénarios
| Scénario | Outil | Preuve attendue |
|----------|-------|-----------------|
| **S1 — C1** : lien à N=500 (puis 1 et 10), 15 000 visiteurs dont 12 000 en 60 s | k6 (`ramping-arrival-rate`), depuis l'instance de charge | Accordés = 500 ; `remaining` = 0 ; 500 tickets ; tous les autres `exhausted` ; retries et conflits relevés ; même `visitorId` → même ticket, y compris après épuisement. Prouve le mécanisme de **réservation** |
| **S2 — C2** : montée 50 → 100 → 300 clients insérant au même index du **même document** | k6 WebSocket ou script Node + Yjs | Hash identique chez tous ; insertions acceptées − suppressions = longueur finale ; `seq` contigus ; latence, conflits, retard de la boucle d'événements ; palier atteint |
| **S3 — C3** : créer le lien, modifier, télécharger (petit puis ≥ 100 000 caractères) | script | PDF = dernière modification ; texte complet ; temps de génération |
| **S4 — C4** : 1 e-mail, 5 appareils en parallèle | script | ≤ 10 000 exactement ; suppressions facturées, restauration gratuite ; blocage au 4e refus, levé à minuit UTC (horloge simulée) ; `opId` et hash rejoués non débités |
| **S5 — C5** : S1 + 300 rédacteurs dans le même document (ou palier validé en S2) **en même temps** | k6 (scénarios parallèles) | États explicites pour tous ; rédacteurs non perturbés ; CPU et mémoire de l'instance |
| **S6 — C6** : délai entre le dernier exemplaire et le premier `exhausted` vu | script | Délai mesuré ; appels DynamoDB et PDF après épuisement ≈ 0 |
| **S7 — Robustesse** : `kill -9` du processus pendant S2 (palier 50) | script | Après redémarrage systemd : tous les updates acquittés présents ; non acquittés renvoyés ; aucun doublon débité |
| Unitaires / intégration | Vitest + DynamoDB Local (Docker) | Crédit, claim, idempotence, `commitGroup`, annulations |

### 4.3 Conditions de test
- Le générateur de charge tourne dans la **même région**, sur une autre instance : ta connexion locale ne mesure que ton réseau.
- Un visiteur ne fait pas un seul appel : modéliser 1 `status`, 1 `claim`, quelques `file` avec `Retry-After`.
- Résultats bruts conservés dans `/tests/results/` avec l'heure, le type d'instance et la version déployée.
- Répéter S1 au moins 3 fois ; essai à petite échelle avant chaque gros essai.
- Redimensionner **par la mesure** : si `CPUCreditBalance` tombe ou si le retard de la boucle d'événements monte, changer de type et le noter dans le rapport.

---

## 5. Livrables — plan de contenu

### 5.1 Dépôt Git et README
Prérequis, `aws login`, paramètres du template (ton IP, paire de clés, expéditeur SES), commande de déploiement, de test, de suppression, **vérification de suppression complète**, section « Transparence » déclarant l'usage d'un assistant IA.

### 5.2 Dossier de conception
1. Contexte, hypothèses et décisions (tableau 1.4)
2. Contraintes → réponses (tableau 1.2)
3. Architecture et flux critiques (claim, écriture, PDF, notification)
4. **ADR** : un par ligne du tableau 2.1, avec alternatives écartées (dont les quotas mesurés)
5. Modèle de données
6. Sécurité et bonnes pratiques (section 6)
7. Limites assumées : instance unique, HTTP sans domaine, identité sans compte ; pistes : répartir les documents sur plusieurs instances par `docId`, répartiteur de charge, CloudFront

### 5.3 Rapport de test
Méthode → objectifs → résultats bruts → analyse (écarts, goulots, corrections, changement de type d'instance éventuel) → **preuve C1 et C2** (chiffres avant/après).

### 5.4 Description de l'API
OpenAPI (REST) et spécification des messages WebSocket, assez précises pour que le jury écrive son test.

| Endpoint | Rôle |
|----------|------|
| `GET /health` | état du service |
| `POST /session` | nom + e-mail → JWT |
| `POST /ws-ticket` | ticket à usage unique (60 s) pour ouvrir le WebSocket |
| `GET /me/credit` | crédit restant du jour |
| `POST /documents`, `GET /documents`, `GET /documents/{id}` | créer / lister / lire |
| `POST /documents/{id}/members` | donner accès |
| `POST /documents/{id}/updates`, `GET /documents/{id}/updates?since={seq}` | repli HTTP de l'édition (mêmes règles) |
| `GET /documents/{id}/versions`, `POST /documents/{id}/versions/{n}/restore` | historique / restauration |
| `POST /documents/{id}/links` | créer un lien (`maxDownloads`) |
| `GET /d/{token}/status` | état public (micro-cache) |
| `POST /d/{token}/claim` | réserver un exemplaire (idempotent via `visitorId` : un retry renvoie le même ticket, même quota épuisé) |
| `GET /d/{token}/file` | URL présignée du PDF, ou `waiting` |
| `GET /admin/state` | supervision (clé admin) |
| WebSocket | messages JSON : `join {documentId, sinceSeq}`, `update {opId, documentId, payload}` (Base64), `awareness`, `ack {opIds, seq}`, `presence`, `error` (`CREDIT_EXHAUSTED`, `BLOCKED`, `FORBIDDEN`) |

Réponses visiteur : `ready` (200 + URL) · `waiting` (202 + `retryAfter`) · `exhausted` (410).

Exemple de message d'écriture :
```json
{"type":"update","opId":"op_12345","documentId":"doc_123","payload":"<update Yjs en Base64>"}
```

### 5.5 Preuve de coût
- Captures de **Billing and Cost Management** (solde des crédits, date de fin du plan gratuit) et de Cost Explorer par service ; capture des Budgets
- Calcul à partir des métriques d'usage (heures d'instance application + charge, Elastic IP, requêtes DynamoDB, S3, SQS, SES) × tarifs publics, car la facturation affiche ~24 h de retard
- Estimation avec le calculateur AWS pour une année d'usage hypothétique

---

## 6. Bonnes pratiques du cours — liste de contrôle
- [ ] **Moindre privilège** : politique du rôle d'instance par ressource (`s3:ListBucket` sur le bucket, `s3:GetObject` / `s3:PutObject` sur `…/*`, tables DynamoDB nommées, file SQS nommée, `ses:SendEmail` limité à l'identité vérifiée, `ssm:GetParameter` sur `/editeur/*`) ; aucun `*` inutile
- [ ] **Aucune clé d'accès** dans le code ni l'historique (identifiants AKIA) : `aws login` côté poste, rôle d'instance (identifiants ASIA) côté serveur ; scan `gitleaks` de l'historique complet avant rendu
- [ ] Double authentification activée ; pas d'utilisateur IAM inutile
- [ ] **S3** : accès public bloqué, chiffrement, stratégie refusant le trafic non HTTPS, versionnage, URLs présignées de 60 s
- [ ] **Security Group** : 80 ouvert, 22 limité à ton IP /32 (jamais 0.0.0.0/0), pas de groupe `launch-wizard`
- [ ] **IMDSv2 uniquement**, crédits CPU en **Standard**, **aucun secret dans le user data**
- [ ] **Étiquettes** `Proprietaire` et `Projet` sur toutes les ressources ; nom de ressource contenant ton prénom
- [ ] **SQS** : consommateur idempotent, file de lettres mortes, long polling
- [ ] **Coûts** : Budgets, Elastic IP comptée (IPv4 publique facturée), instance de charge arrêtée après les tests, rétention des journaux courte, suppression propre à la fin
- [ ] Une seule région, vérifiée dans le template
- [ ] Limites assumées écrites dans le dossier : pas de haute disponibilité, pas de HTTPS sans domaine
- [ ] Validation et taille maximale des entrées (messages ≤ 64 Ko, noms, e-mails) ; CORS restreint ; ticket WebSocket à usage unique

---

## 7. Risques principaux

| Risque | Impact | Parade |
|--------|--------|--------|
| Instance unique | Panne = service coupé | `Restart=always`, état reconstruit depuis DynamoDB, test S7, limite documentée |
| CPU `t3` bridé | Latence, résultats faussés | Surveiller `CPUCreditBalance`, changer de type, noter dans le rapport |
| Boucle d'événements Node saturée (300 écrivains) | Latence | Ticks, regroupement client, PDF en worker thread, mesure du retard, palier rapporté |
| Throttling DynamoDB | Retries, latence | Mode à la demande, transactions groupées, retry avec gigue, mesure de `ThrottledRequests` |
| Descripteurs de fichiers insuffisants | Connexions refusées | `LimitNOFILE`, `worker_rlimit_nofile`, test à 12 000 connexions |
| Élément `Links` très sollicité | Throttling | Garde mémoire, plafond de transactions en vol, court-circuit `EXHAUSTED` |
| Phase 2 qui s'enlise | Tout décale | Point de contrôle 00h30, repli HTTP, C1 déjà prouvé en phase 1b |
| Update de taille excessive | Message refusé | Plafond 64 Ko, regroupement, compaction |
| Retries (claim, update) | Exemplaire ou crédit en double | `visitorId`, `opId`, hash, relecture du ticket |
| SES en bac à sable | Pas d'e-mail pour le jury | Demande d'accès production en phase 0 |
| Pas de HTTPS | Trafic en clair | Limite documentée ; CloudFront optionnel |
| Adresse IP de ton poste qui change | SSH bloqué | Mise à jour de la règle /32, ou Session Manager |
| Perte des preuves à la suppression | Pas de preuve des tests | Export avant `delete-stack` |
| Dépassement de budget | Facture ou fermeture du compte | Budgets, instance de charge arrêtée, suppression après correction |
| Règle « Travail individuel » interprétée | Contestation | Usage d'un assistant IA déclaré dans le README |

---

## 8. Checklist finale (lundi 07h30)
- [ ] S1, S2 et S7 réussis ; résultats bruts, métriques et journaux archivés avant toute suppression
- [ ] README exécuté de zéro sur un déploiement propre
- [ ] Dossier de conception, rapport de test, description d'API relus
- [ ] Preuves de coût capturées
- [ ] Procédure de suppression testée ; exécutée seulement après la correction
- [ ] Dépôt propre : aucun secret, aucun fichier inutile ; jury ajouté ; **dernier push avant 07h30**
