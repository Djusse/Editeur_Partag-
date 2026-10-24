**Plan d'exécution — Éditeur de documents partagé (AWS)**  
**Auteur :** Djusse Tameno Christian — 5e année Génie informatique, ENSPY  
   
 **Cours :** Cloud (5 jours × 8 h) — Projet d'évaluation individuel  
   
 **Version :** v6 — samedi 24/10/2026, 10h45  
   
 **Fenêtre de travail :** samedi 24/10 10h45 → lundi 26/10 **08h00** (délai ferme : tout le code sur GitHub, aucune modification acceptée ensuite) ; dernier push prévu à **07h30**  
   
 **Stack retenue :** Next.js (export statique) + Lambdas Node.js/TypeScript + AWS SAM  
  
---  
**1. Analyse du sujet**  
**1.1 Ce que le jury évalue vraiment**  
Le sujet le dit : l'essentiel de la note porte sur **les choix d'architecture et leur justification**, pas sur le volume de fonctionnalités. Une application simple, dont chaque choix est défendu avec des preuves chiffrées, vaut mieux qu'une application riche mal expliquée.  
**1.2 Les 6 contraintes → problème technique → réponse retenue**  
  
|  |  |  |  |  
| - | - | - | - |  
| **#** |  **Contrainte** |  **Vrai problème** |  **Réponse retenue** |  
| C1 |  Exactement N téléchargements, jamais N+1 |  Concurrence sur un compteur |  `UpdateItem` DynamoDB **conditionnel et atomique** (`remaining > 0`), jamais lecture puis écriture |  
| C2 |  Aucune modification perdue, convergence |  Édition concurrente au même endroit |  **CRDT (Yjs)** : fusion commutative, journal d'updates append-only |  
| C3 |  Lien = document à l'instant T1 |  PDF obsolète / incohérent |  PDF **généré à la demande**, à partir d'une **version figée** (n° de séquence lu au moment du claim), cache par version |  
| C4 |  Crédit 10 000 car./jour, multi-appareils |  Compteur partagé entre connexions |  Compteur **serveur** unique par (email, jour), incrément conditionnel atomique, **réservation avant acceptation** |  
| C5 |  Pic 15 000 visiteurs (80 % en 60 s) + 300 rédacteurs |  Charge ≈ 200 req/s soutenue, réponse garantie |  Cache CloudFront sur l'état du lien, chemin de claim minimal, PDF mutualisé, états explicites (prêt / patienter / épuisé) |  
| C6 |  Dernier exemplaire → visiteurs prévenus vite, plus de travail inutile |  Arrêter de servir à vide |  État `EXHAUSTED` **monotone** : réponse mise en cache longtemps, court-circuit avant tout calcul |  
  
   
C1 et C2 sont éliminatoires : elles passent **en premier** et doivent être prouvées par des tests.  
**1.3 Points d'attention cachés dans le sujet**  
- **« Ni casser, ni jeter »** : un 429 ou un timeout brut compte comme visiteur jeté. Toute requête doit recevoir un des 3 états explicites.  
- **« Patienter »** implique un état intermédiaire réel : il vient naturellement de la génération du PDF (une seule génération partagée par tous).  
- **C3 + C5** sont en tension (PDF frais vs 500 téléchargements simultanés) → cache PDF **par version du document**.  
- **Quotas d'un compte neuf** : la concurrence Lambda peut être plafonnée très bas (parfois 10). À vérifier dès la première heure, sinon C5 est menacé.  
- **Preuve de coût** : les données de facturation (Cost Explorer) ont jusqu'à \~24 h de retard → les tests de charge doivent être terminés **dimanche soir au plus tard**.  
- **Plan gratuit** : les conditions ont évolué (crédits limités dans le temps selon l'ancienneté du compte). Relire les conditions actuelles de ton compte et poser une alerte budget.  
- La règle « Travail individuel » est **tronquée** dans le PDF (« strictement personnel : ... »). Réponse obtenue : bibliothèques open source autorisées ; l'usage d'un assistant IA est jugé implicitement autorisé (interprétation, non confirmée) → **déclaré dans le README**.  
- **SES** : en bac à sable, aucun e-mail n'arrive au jury. Demander l'accès production **dès le départ** (délai de validation jusqu'à \~24 h).  
- **Fan-out WebSocket** : chaque frappe diffusée à n clients coûte n appels `postToConnection` (coût quadratique). À 300 rédacteurs dans un même document avec 1 update/s chacun, cela ferait \~90 000 appels/s : impossible. Il faut regrouper côté client (`BATCH_MS`) **et** diffuser par lots (un tick de 250–500 ms ≈ 600–1 200 appels/s), plafonner la taille des messages et vérifier le quota `@connections` en phase 0.  
- **PDF et timeout** : API Gateway coupe à 29 s. La génération du PDF ne doit **jamais** se faire dans la requête du visiteur.  
- **API Gateway WebSocket n'accepte pas les trames binaires** (connexion fermée, code 1003) ; trame max 32 Ko, message max 128 Ko. Les updates Yjs binaires doivent donc voyager en **Base64 dans des messages JSON**, avec un plafond de \~16 Ko de binaire par update (Base64 +33 %, plus l'enveloppe JSON). À tester dès que 2 clients communiquent.  
- **Retries et doublons** : une réponse perdue puis un retry ne doivent ni consommer un 2e exemplaire (claim) ni débiter 2 fois le crédit (update). Idempotence obligatoire des deux côtés (`visitorId`, `opId`).  
**1.4 Décisions et hypothèses (validées par toi ; aucune n'est confirmée par le professeur)**  
À reprendre telles quelles dans le dossier de conception, marquées « hypothèse ».  
  
|  |  |  
| - | - |  
| **Sujet** |  **Décision** |  
| Consommation d'un exemplaire |  Au clic qui réserve le téléchargement (claim), pas à la fin du téléchargement |  
| T1 |  Le clic : lecture de `seq` au début du claim |  
| Crédit |  10 000 caractères/jour : insertions **et** suppressions comptées ; restauration de version gratuite |  
| Recharge |  Minuit UTC |  
| Blocage |  4 refus pour crédit épuisé dans la journée UTC → écriture bloquée jusqu'au prochain minuit UTC (heure de recharge) ; la lecture reste possible |  
| Pic d'écriture |  300 rédacteurs dans le **même** document (pire cas) ; le palier réellement atteint est rapporté |  
| Test du jury |  Deux cas : URL déployée et redéploiement depuis le dépôt (README) |  
| Livrables |  Markdown, français, dépôt GitHub **privé** (jury ajouté en collaborateur) |  
| Interface |  Fonctionnelle, simple, moderne |  
| E-mail |  Adresse Gmail vérifiée comme expéditeur SES (pas de domaine) ; si l'accès production SES est refusé, démonstration avec adresses vérifiées, documentée |  
| Travail individuel |  Bibliothèques open source autorisées ; assistant IA considéré comme implicitement autorisé et **déclaré dans le README** |  
| Échéance |  Lundi 08h00 ; dernier push 07h30 |  
  
   
  
---  
**2. Architecture proposée (serverless, une seule région)**  
**Région :** `eu-west-3` (Paris) — proche de Yaoundé, services nécessaires disponibles. Repli : `eu-west-1`.  
```  
Navigateur (SPA)         (ticket WS à usage unique obtenu via POST /ws-ticket)  
    │  HTTPS                         │  WSS  
    ▼                                ▼  
 CloudFront ── S3 (front statique)   API Gateway WebSocket  
    │                                   │  
    ├─ /api/*  ─► API Gateway HTTP ─► Lambda (REST)       Lambda (WS : connect / message / disconnect)  
    │                                   │                       │  
    └─ /d/*/status (cache 1-2 s)        └──────────┬────────────┘  
                                                   ▼  
                                    DynamoDB (tables ci-dessous)  
                                         │ Streams  
                                         ▼  
                                Lambda notify ─► SES (e-mail dernier exemplaire)  
   
 Lambda pdf (invoquée en asynchrone par le claim) ─► S3 privé (pdf/{docId}/v{seq}.pdf, snapshots) ─► URL présignée courte durée  
 SSM Parameter Store : secret JWT, clé admin  
   
```  
**2.1 Choix et justifications (à reprendre en ADR dans le dossier de conception)**  
  
|  |  |  |  |  
| - | - | - | - |  
| **Sujet** |  **Choix** |  **Justification** |  **Alternative écartée** |  
| Calcul |  Lambda (Node.js 22 / TypeScript) |  Pic brutal et court : paiement à l'usage, scalabilité sans gestion de serveurs, même langage que Yjs et le front |  EC2/ECS : coût fixe, capacité à dimensionner pour un pic de 1 minute ; Spring Boot (Lambda ou EC2) : démarrages à froid de la JVM, pas de bibliothèque Yjs côté serveur, une seule machine fragilise le pic |  
| Temps réel |  API Gateway WebSocket (repli : HTTP `POST /updates` + `GET /updates?since=seq` toutes les secondes) |  Géré, pas de serveur à maintenir, `@connections` pour diffuser. Messages **JSON** avec updates Yjs en **Base64** (le service refuse le binaire). Le repli HTTP garde Yjs, donc la convergence (C2) |  Serveur y-websocket sur EC2 : état en mémoire, difficile à scaler |  
| Auth WebSocket |  Ticket à usage unique (60 s) via `POST /ws-ticket`, passé en query string |  Le navigateur ne permet pas d'en-têtes personnalisés sur un WebSocket ; un ticket jetable évite d'exposer le JWT dans les logs |  JWT dans l'URL : réutilisable s'il fuit |  
| Comptage du crédit |  Décodage de l'update **côté serveur**, avec plafond de taille |  Un client ne doit pas pouvoir mentir sur ses caractères (C4 doit tenir face au test du jury). Lire la structure d'un update ne demande pas de reconstruire un `Y.Doc`. Règle : l'expéditeur authentifié est facturé de **tous** les caractères insérés et supprimés par l'update, quel que soit le `clientID` (le `clientID` n'est pas une preuve d'identité) ; rejouer du contenu ne peut que le surfacturer ; les suppressions sont facturées aussi (longueur des plages du delete set) ; la restauration de version est gratuite (update système appliqué par le serveur) |  Comptage déclaré par le client : contournable |  
| Fusion |  Yjs (`Y.Text`) |  Garantit la convergence (C2) sans verrou ni perte |  OT maison : très risqué en un week-end |  
| Base |  DynamoDB |  Écritures conditionnelles atomiques (C1, C4), TTL, Streams |  RDS : pas dans le gratuit durable, verrous lourds |  
| Fichiers |  S3 privé + URL présignées |  Imposé par le sujet, aucune exposition publique |  — |  
| Front |  Next.js en **export statique** (`output: 'export'`, S3 + CloudFront) + CodeMirror 6 + `y-codemirror.next` |  Next.js déjà maîtrisé ; l'export statique évite de héberger un serveur Next ; curseurs distants et présence prêts à l'emploi. Routes dynamiques par query string (`/doc?id=…`, `/d?token=…`) car l'export statique ne connaît pas les identifiants à l'avance |  Next.js SSR : serveur à héberger ; Vite : outil nouveau |  
| PDF |  `pdfkit` ou `pdf-lib` (JS pur), génération **asynchrone** |  Texte simple, démarrage rapide, pas de navigateur headless ; aucun risque de timeout API Gateway |  Chromium headless : lourd, lent, cher |  
| IaC |  AWS SAM (CloudFormation) |  Un `sam deploy` / un `sam delete` → répond au README « déployer, tester, supprimer » |  Terraform/CDK : plus de mise en place |  
| Identité |  JWT HS256 signé, émis à l'entrée (nom + e-mail) |  Suffisant selon le sujet ; limite documentée |  Cognito : hors périmètre demandé |  
| E-mail |  SES via DynamoDB Streams |  Découplé du chemin critique, idempotent |  Envoi synchrone dans le claim : ralentit le pic |  
  
   
**2.2 Modèle de données DynamoDB (à valider en phase 0)**  
  
|  |  |  |  
| - | - | - |  
| **Table** |  **Clé** |  **Contenu principal** |  
| `Documents` |  `docId` |  titre, propriétaire, membres (emails), `seq` (compteur d'updates), `latestSnapshotSeq` |  
| `Updates` |  `docId` + `seq` |  update Yjs (stocké en binaire, Base64 en transit), auteur, `opId`, nb de caractères insérés ; les `seq` sont contigus (avancés uniquement dans la transaction d'écriture) |  
| `Connections` |  `connectionId` (GSI `docId`) |  email, nom, couleur, curseur, TTL |  
| `Credits` |  `email#YYYY-MM-DD(UTC)` |  `used`, TTL 48 h |  
| `OpIds` |  `OP#email#opId` et `HASH#docId#sha256` (deux éléments distincts) |  marqueurs d'update déjà comptabilisé ; `OP#` stocke `hash` et `seq`, `HASH#` stocke `seq` (pour renvoyer l'`ack` d'origine), TTL 48 h |  
| `Abuse` |  `email#YYYY-MM-DD(UTC)` |  compteur de refus du jour, `blockedUntil` (= prochain minuit UTC), TTL 48 h |  
| `Links` |  `token` |  `docId`, créateur, `maxDownloads`, `remaining`, `status` (ACTIVE / EXHAUSTED), `notified` |  
| `Tickets` |  `token` + `visitorId` |  `seqFigée`, état PDF, horodatage (idempotence) |  
| `PdfCache` |  `docId#seq` |  état (BUILDING / READY), clé S3 |  
| `Versions` |  `docId` + `n` |  clé S3 du snapshot, auteur, date |  
  
   
Facturation : DynamoDB **à la demande** (simplicité face au pic, coût négligeable à cette échelle) ; à justifier dans le dossier.  
**2.3 Algorithmes critiques**  
**Claim d'un téléchargement (C1, C3, C5, C6)**  
1. Le visiteur génère un `visitorId` (aléatoire, côté client) → idempotence : un retry renvoie **le même ticket** et ne consomme jamais un 2e exemplaire.  
2. `GET /d/{token}/status` (mis en cache 1–2 s) : `active` / `exhausted`. Si `exhausted` → réponse mise en cache longtemps, **aucun calcul** (C6).  
3. `POST /d/{token}/claim` :  
  - a. `GetItem` du ticket `(token, visitorId)` : s'il existe, le renvoyer (même si `remaining` = 0).  
  - b. Lire `seq` courant du document (lecture cohérente) : c'est la `seqFigée`. **Définition : T1 = instant où le serveur fixe la version du document, soit la lecture de `seq` au début du claim** (à écrire dans les ADR et le rapport). Distinguer trois versions : celle fixée dans le ticket, la version courante du document, et celle du PDF généré. **Le PDF est construit à partir de la `seqFigée`** (snapshot + updates ≤ `seqFigée`), jamais du texte courant au moment où la Lambda s'exécute. **Aucune condition sur ce `seq` dans la transaction** : le document change en continu, chaque claim échouerait et le document deviendrait une clé chaude.  
  - c. `TransactWriteItems` = décrément `remaining` (condition `remaining > 0`) **+** création du ticket avec `seqFigée` (condition `attribute_not_exists`).  
  - d. Si la transaction est annulée : relire le ticket (réponse perdue lors d'un essai précédent) ; s'il existe, le renvoyer ; sinon c'est `exhausted`.  
  - succès → ticket créé ; échec de condition → `410 exhausted`.  
  - `TransactionConflict` / throttling → retry avec backoff + jitter (mesurer leur nombre dans S1) ; jamais d'erreur brute vers le visiteur.  
4. Résolution du PDF : si `PdfCache(docId#seqFigée)` est `READY` → URL présignée (60 s). Sinon, un seul claimant prend le verrou `BUILDING` (put conditionnel) et **déclenche la Lambda pdf en asynchrone** ; **tous** (lui compris) reçoivent immédiatement `202 waiting` + `Retry-After` et font du polling sur `/file`.  
5. Quand `remaining` atteint 0 : `status = EXHAUSTED`, le Stream déclenche l'e-mail (flag `notified` conditionnel → un seul envoi).  
*Décision à documenter : un exemplaire est « consommé » au* ***claim*** *(ticket), pas au clic sur l'URL présignée. C'est ce qui garantit « jamais N+1 » même si l'URL est téléchargée plusieurs fois.*  
**Crédit d'écriture (C4)**  
1. Le client envoie un message JSON `{opId, update(Base64)}` (≤ 16 Ko de binaire) ; le serveur calcule le nombre de caractères **insérés et supprimés** (tous, quel que soit le `clientID` ; suppressions = longueur des plages du delete set) en décodant la structure de l'update, sans reconstruire de `Y.Doc`. Mesurer le coût CPU en phase 3.  
2. Lire `seq` courant de `Documents` (= `s`), puis **une seule** `TransactWriteItems` sur 5 éléments distincts (une transaction ne peut pas cibler deux fois le même élément) :  
  - `Documents` : `SET seq = :s+1`, condition `seq = :s`  
  - `Updates[s+1]` : `Put`, condition `attribute_not_exists`  
  - `Credits[email#jour]` : `ADD used :n`, condition `used + :n <= 10000`  
  - `OpIds[OP#email#opId]` : `Put` (stocke `hash` et `seq`), condition `attribute_not_exists`  
  - `OpIds[HASH#docId#sha256]` : `Put` (stocke `seq`), condition `attribute_not_exists`  
   
 Tout réussit ou rien n'est appliqué : aucun trou de `seq`, aucun crédit débité pour un update non persisté, aucun `opId` marqué sans update.  
3. Lire les `CancellationReasons` : conflit sur `Documents` → relire `seq` et réessayer (backoff + jitter, nombre borné) ; `Credits` → `error: CREDIT_EXHAUSTED` ; `OP#` ou `HASH#` → relire le marqueur : même `opId` et même hash → `ack` avec le `seq` d'origine, sans débit ; même `opId` mais hash différent → rejet ; même hash sous un autre `opId` → `ack` avec le `seq` d'origine, sans débit. Si accepté : `ack`, puis diffusion aux connexions du document. Un update non acquitté reste dans le client, qui le renvoie avec le **même** `opId`.  
4. Après `CREDIT_EXHAUSTED`, le client repasse en lecture seule et **cesse d'envoyer** (file locale vidée) ; sinon il atteindrait seul les 4 refus et se bloquerait lui-même.  
5. **Blocage** : chaque refus pour crédit épuisé incrémente `Abuse[email#jour]` (un même `opId` rejoué n'est compté qu'une fois) ; au 4e refus dans la journée UTC → `blockedUntil` = prochain minuit UTC, l'heure de recharge ; toute écriture d'un utilisateur bloqué reçoit `BLOCKED` immédiatement.  
6. Insertions et suppressions consomment du crédit ; la restauration de version est gratuite (à documenter).  
7. Le `ClientRequestToken` de DynamoDB ne protège que 10 minutes : la déduplication durable repose sur la table `OpIds` (TTL 48 h). Cette durée est une **fenêtre de déduplication**, pas une garantie permanente. La garantie visée est « jamais plus de 10 000 caractères acceptés » : un doublon présenté sous une autre forme peut surfacturer, jamais sous-facturer.  
**Édition concurrente (C2)**  
- Le serveur attribue un `seq` total et **contigu** à chaque update accepté (avancé uniquement dans la transaction d'écriture) ; le client rejoue les updates manquants à la connexion (`sinceSeq`). Un trou est donc détectable et anormal. Filet de sécurité : resynchronisation périodique par état (state vector).  
- **Contention** (cible : 300 rédacteurs dans un document) : un compteur par document sérialise les écritures. La persistance est isolée dans `commitBatch(docId, updates[])` (une transaction pour N updates, `seq += N`) : N=1 en phase 2, puis lots via une file SQS FIFO par document (`MessageGroupId = docId`) en phase 2b si S2 le justifie. La file déplace le problème vers la latence ; le worker doit finir la persistance avant de supprimer le message ; l'idempotence (`opId`, hash) reste nécessaire ; l'`ack` devient asynchrone. Si le crédit d'un expéditeur est refusé dans un lot, ses updates sont retirés du lot et la transaction est relancée.  
- **Regroupement côté client** (`BATCH_MS`, 300 ms par défaut, 1 s sous forte charge) : les frappes sont fusionnées en un update, ce qui réduit le fan-out et le nombre d'invocations.  
- **Logique en bibliothèque pure** (appliquer un update, crédit, claim) testée contre DynamoDB Local ; les handlers Lambda restent très fins. Cela permet de déboguer le CRDT hors du cloud sans serveur y-websocket jetable.  
- Compaction : snapshot S3 toutes les \~N updates ; les versions consultables = snapshots horodatés.  
- Restauration : on **applique un nouvel update** qui remplace le texte par celui de la version choisie (compatible CRDT, historique conservé).  
  
---  
**3. Phasage d'exécution (calé sur le temps restant)**  
**Phase 0 — Cadrage et fondations (sam. 10h45 → 12h00)**  
- Sécuriser le compte : MFA sur le compte racine, utilisateur IAM / Identity Center pour le travail courant (jamais la racine)  
- **AWS Budgets** : alerte à 1  et 5  ; noter la date de début pour la preuve de coût  
- **Compte neuf (plan gratuit avec crédits)** : vérifier que Lambda, API Gateway WebSocket, DynamoDB, SQS, SES et CloudFront sont utilisables ; noter la date de fin des crédits. Pas de second compte pour contourner les limites : la preuve de coût doit venir du compte qui héberge l'application  
- Règle « Travail individuel » : bibliothèques open source autorisées (réponse reçue) ; usage d'un assistant IA déclaré dans le README  
- **Service Quotas** : concurrence Lambda, limites API Gateway, débit de `postToConnection` (`@connections`), SQS FIFO ; demander une augmentation si le plafond est très bas  
- **SES** : vérifier ton adresse, **envoyer un e-mail de test vers toi**, et demander l'accès production dès maintenant (en bac à sable, on n'envoie qu'à des adresses vérifiées) ; expéditeur : ton adresse Gmail vérifiée  
- Dépôt GitHub **privé** + `.gitignore` + hook anti-secrets (`gitleaks`) avant le premier commit ; demander l'identifiant GitHub du jury pour l'ajouter en collaborateur (lecture)  
- Poste de travail : Node.js 22, AWS CLI, SAM CLI, Docker (DynamoDB Local), k6, Git  
- Structure : `/infra` (SAM), `/backend`, `/frontend`, `/tests`, `/docs`  
- Figer le modèle de données et l'API (ébauche OpenAPI) ; ouvrir `docs/adr/` et écrire les 3 premiers ADR (calcul, base, temps réel)  
- Journal de coûts et de décisions : un fichier `docs/journal.md` alimenté au fil de l'eau  
**Phase 1 — Socle et déploiement bout en bout (sam. 12h00 → 14h30)**  
- Prise en main (≈ 45 min) : un « hello » Lambda + une table DynamoDB déployés avec SAM, pour valider la chaîne avant d'écrire la logique  
- Template SAM : S3 (front + PDF, accès public bloqué), CloudFront (OAC), DynamoDB, API HTTP, rôles IAM **par fonction** (moindre privilège)  
- `POST /session` (nom + e-mail → JWT), middleware d'authentification, secret en SSM  
- CRUD documents + partage par e-mail (liste des membres)  
- Front minimal (Next.js export statique, routes par query string) : écran d'entrée, liste, création  
- **Premier déploiement complet** (`sam deploy`) pour valider la chaîne tôt ; premier `sam delete` de test en fin de phase pour valider la suppression  
**Phase 1b — C1 en premier : liens à quota strict (sam. 14h30 → 17h30)**  
C1 est la contrainte éliminatoire la plus simple à prouver : on la sécurise avant le temps réel, avec un PDF factice (fichier fixe).  
- `POST /documents/{id}/links` (`maxDownloads`), `GET /d/{token}/status` (cache court), `POST /d/{token}/claim` (algorithme section 2.3), `GET /d/{token}/file` (URL présignée d'un PDF factice)  
- Lecture de garde + court-circuit `EXHAUSTED`, retry avec jitter sur `TransactionConflict`  
- Tests locaux (DynamoDB Local) : N=1, N=10, concurrence forte, retry avec le même `visitorId`  
- **S1 à petite échelle sur AWS** (N=10, quelques centaines de requêtes), puis un premier S1 complet si le temps le permet ; archiver les résultats bruts  
- Alerte si le quota de concurrence Lambda ou les limites d'API Gateway sont atteints : corriger **maintenant**  
**Phase 2 — Temps réel + convergence (sam. 17h30 → 22h30) — cœur de C2**  
**Point de contrôle samedi 21h30** : si 2 clients WebSocket ne convergent pas encore, basculer sur le repli HTTP (`POST /updates` + `GET /updates?since=seq` toutes les secondes, Yjs conservé) et avancer. **Plafond : 4 h sur ce point.** Le repli reste conforme à C2 ; une simple « sauvegarde + polling » qui écrase le texte ne l'est pas.  
- Bibliothèque pure (appliquer un update, rattrapage `sinceSeq`) + tests en local contre DynamoDB Local **avant** le déploiement  
- `POST /ws-ticket` (ticket 60 s, usage unique) ; API Gateway WebSocket : `$connect` (ticket + accès au document), `$disconnect`, route `update` / `awareness`  
- Messages **JSON uniquement**, updates en Base64, plafond 16 Ko de binaire ; **vérifier les tailles réelles des messages dès que 2 clients communiquent**  
- Persistance des updates par la **transaction unique** de la section 2.3 (version sans `Credits` ni `OpIds` en phase 2, ajoutés à la même transaction en phase 3), diffusion aux connexions du document, gestion des connexions mortes (410 → nettoyage)  
- Rattrapage à la reconnexion (`sinceSeq`)  
- Front : CodeMirror + provider WebSocket Yjs maison avec regroupement `BATCH_MS`, présence (liste des personnes + curseurs colorés)  
- **Test de convergence immédiat** (2 puis 10 clients scriptés au même endroit) avant d'avancer  
**Phase 2b — Passage à l'échelle d'un document (dim. 08h30 → 10h30)**  
Objectif cible : 300 rédacteurs dans un même document (hypothèse validée). Déclenchée si S2 au palier 100 montre trop de conflits ; sinon le temps va à la phase 3.  
- `commitBatch(docId, updates[])` : une transaction pour N updates (`seq += N`), crédits d'un même expéditeur agrégés, limite de 100 actions par transaction respectée  
- File SQS FIFO (`MessageGroupId = docId`, déduplication par `opId`), worker Lambda traitant des lots (≤ 10 messages) via `commitBatch` ; `ack` envoyé par le worker après réussite de la transaction  
- Diffusion groupée : une diffusion par lot (tick de 250–500 ms), `postToConnection` en parallèle borné  
- Paramètre `BATCH_MS` côté client (300 ms par défaut, 1 s en charge), valeur justifiée par S2  
- Relancer S2 aux paliers 100 puis 300 ; relever latence de propagation, taille de file, conflits  
**Phase 3 — Crédit et anti-abus (dim. 10h30 → 13h00)**  
Définir d'abord la règle métier (l'expéditeur authentifié paie tous les caractères insérés **et supprimés** par l'update, quel que soit le `clientID` ; la restauration est gratuite), puis coder, puis tester avant l'interface. Risque de planning majeur : prévoir une marge.  
- Ajouter `Credits` et `OpIds` (`opId` + hash de l'update) à la transaction d'écriture ; lecture des `CancellationReasons`, voir section 2.3  
- Comptage **serveur** des caractères insérés **et supprimés** (longueur des plages du delete set) + plafond de taille ; mesurer le temps CPU par update  
- Blocage au 4e refus de la journée UTC, levé à minuit UTC (`Abuse`) + code d'erreur côté client + `GET /me/credit`  
- Test : 1 utilisateur, 5 connexions simultanées → total accepté ≤ 10 000, exactement  
- Test : suppressions consommant du crédit ; restauration de version gratuite  
- Test : renvoi du même `opId` (timeout simulé) → débité une seule fois  
- Test : même contenu renvoyé sous un nouvel `opId` → `ack` d'origine, sans débit (hash)  
- Test : même `opId` avec un contenu différent → rejeté ; deux insertions concurrentes ; update renvoyé après reconnexion (même `opId`) → débité une seule fois  
**Phase 4 — PDF réel, e-mail, cache (dim. 13h00 → 15h30) — C3, C5, C6**  
- Remplacer le PDF factice de la phase 1b par la génération réelle depuis la `seqFigée` du ticket  
- Génération PDF **asynchrone** (Lambda invoquée en `Event`) + cache par version + verrou `BUILDING` + réponse `waiting` immédiate pour tous ; mesurer le temps de génération sur un petit et un gros document (≥ 100 000 caractères)  
- Retry avec jitter sur `TransactionConflict`  
- Mise en cache CloudFront de `status` ; en-têtes `Cache-Control` différents pour ACTIVE / EXHAUSTED  
- Stream → Lambda notify → SES (idempotent)  
- Page visiteur : trois états lisibles, polling avec backoff + jitter, jamais d'état vide  
**Phase 5 — Versions, supervision (dim. 15h30 → 17h00)**  
- Snapshots, liste des versions, restauration  
- `GET /admin/state` (clé admin en SSM) : documents ouverts, liens actifs + restants, personnes bloquées ; page admin simple  
**Phase 6 — Tests de charge et preuves (dim. 17h00 → 21h00) — à terminer avant 21h**  
(voir section 4)  
**Phase 7 — Documents à rendre (dim. 21h00 → 01h00, puis lun. 06h00 → 07h30)**  
**Règle : documentation au fil de l'eau.** À la fin de chaque phase, 15 min pour l'ADR correspondant et les notes de test ; la phase 7 ne sert qu'à assembler et relire.  
- Dossier de conception (section 5)  
- Description de l'API (OpenAPI + spec des messages WebSocket)  
- Rapport de test  
- README (déployer / tester / supprimer), vérifié en suivant ses propres instructions  
- **Avant toute suppression** : exporter les résultats bruts (JSON k6, extraits de logs CloudWatch, captures) dans `/tests/results/` — les groupes de logs disparaissent avec la pile  
- **Lundi 06h00 → 07h30** : captures Billing / Cost Explorer (données affichées avec \~24 h de retard, donc possiblement partielles), **calcul du coût à partir des métriques d'usage** (invocations Lambda, capacité DynamoDB, requêtes API Gateway) × tarifs publics, estimation au calculateur AWS ; tout commité avant **07h30** ; vérifier sur GitHub qu'un clone propre contient tout ; jury ajouté en collaborateur  
- **Après le rendu** : ne pas supprimer l'infrastructure tant que le jury peut tester l'URL déployée ; garder l'alerte de budget ; `sam delete` seulement après correction (procédure dans le README)  
- Relecture finale, scan de secrets sur tout l'historique Git, rendu  
**Coupes possibles si le temps manque (dans cet ordre)**  
1. Curseurs distants élaborés (garder une simple liste de présence)  
2. Page admin stylée (garder le JSON)  
3. UI de restauration (garder l'endpoint + un test)  
4. Palier de 300 rédacteurs : documenter le palier réellement atteint plutôt que de forcer l'architecture  
 **Ne jamais couper :** C1, C2, C3, C4 et leurs preuves.  
  
---  
**4. Stratégie de test et de preuve**  
**4.1 Objectifs chiffrés à te fixer (à ajuster après un premier essai)**  
  
|  |  |  
| - | - |  
| **Mesure** |  **Objectif** |  
| Téléchargements accordés vs autorisés |  **exactement égaux** (0 écart) |  
| Requêtes visiteurs sans état explicite (prêt / patienter / épuisé) |  0 ; les éventuels timeouts / 5xx / throttlings AWS sont mesurés et analysés, pas supposés absents |  
| Latence `status` pendant le pic |  p95 < 1 s |  
| Délai d'information « épuisé » après le dernier exemplaire |  < 5 s |  
| Propagation d'une modification entre rédacteurs |  p95 < 1 s |  
| Écarts entre documents finaux des clients |  0 |  
| Palier de rédacteurs simultanés dans un même document |  relevé (cible 300) |  
  
   
**4.2 Scénarios**  
  
|  |  |  |  
| - | - | - |  
| **Scénario** |  **Outil** |  **Preuve attendue** |  
| **S1 — C1** : lien à N=500 (puis N=1 et N=10), 15 000 requêtes `claim` avec 80 % en 60 s |  k6 (`ramping-arrival-rate`) |  Nb d'accordés = 500 ; `remaining` = 0 en base ; nb de tickets = 500 ; tous les autres = `exhausted` ; nb de `TransactionConflict` et de retries relevé ; un retry avec le même `visitorId` renvoie le même ticket (y compris après épuisement) |  
| **S2 — C2** : montée progressive 50 → 100 → 300 clients scriptés qui insèrent au même index du **même document** ; palier atteint relevé |  k6 WebSocket / script Node + Yjs |  Hash identique du document chez tous ; somme (insertions acceptées) − (suppressions) = longueur finale ; `seq` contigus (aucun trou) ; taux de conflits sur `Documents`, nb moyen de tentatives par update, latence de propagation, updates récupérées après reconnexion |  
| **S3 — C3** : créer le lien, modifier, télécharger (petit document puis ≥ 100 000 caractères) |  script |  Le PDF contient la dernière modification ; cohérence du texte (pas de PDF tronqué) ; temps de génération mesuré |  
| **S4 — C4** : 1 e-mail, 5 appareils en parallèle |  script |  Total accepté ≤ 10 000, erreur claire au-delà ; blocage au 4e refus, levé à minuit UTC (horloge simulée) ; suppressions facturées, restauration gratuite ; un même `opId` rejoué n'est débité qu'une fois |  
| **S5 — C5** : S1 + 300 rédacteurs dans le **même document** (ou palier maximal validé en S2) **en même temps** |  k6 (scénarios parallèles) |  Pas de 5xx, états explicites pour tous, rédacteurs non perturbés |  
| **S6 — C6** : mesurer le temps entre l'accord du dernier exemplaire et le premier `exhausted` vu |  script |  Délai mesuré ; comptage des invocations Lambda/PDF après épuisement (doit être \~0) |  
| Unitaires / intégration |  Vitest + DynamoDB Local |  Logique de crédit, de claim, d'idempotence |  
  
   
**4.3 Conditions de test**  
- Générateur de charge dans la **même région** (EC2 `t3.micro` ou `t2.micro` éligible gratuit, ou AWS CloudShell pour de petits tests) : ta connexion locale ne mesure que ton réseau, pas l'application.  
- 15 000 utilisateurs ≠ 15 000 connexions : modélise le comportement réel (1 claim + quelques polls par visiteur).  
- Conserver les **résultats bruts** (sorties k6 JSON, extraits CloudWatch, scans DynamoDB avant/après) dans `/tests/results/`, avec l'heure et la version déployée.  
- Répéter S1 au moins 3 fois ; faire un essai à petite échelle avant le gros.  
  
---  
**5. Livrables — plan de contenu**  
**5.1 Dépôt Git + README**  
Prérequis, commande de déploiement, variables, commande de test, commande de suppression, **vérification de suppression complète**, section « Transparence » déclarant l'usage d'un assistant IA.  
**5.2 Dossier de conception**  
1. Contexte et lecture du besoin, **hypothèses et décisions (tableau 1.4)**  
2. Contraintes et leur traduction technique (tableau section 1.2)  
3. Architecture (schéma) et flux critiques (claim, écriture, PDF, notification)  
4. **ADR** : un par choix, avec alternatives écartées et raison  
5. Modèle de données  
6. Sécurité : moindre privilège par fonction, aucun secret dans le code, S3 privé + OAC, URL présignées courtes, validation des entrées, limites de taille, CORS restreint, limite connue de l'identité sans compte  
7. Pistes d'amélioration / limites assumées  
**5.3 Rapport de test**  
Méthode → objectifs → résultats bruts → analyse (écarts, goulots, corrections faites) → **preuve C1 et C2** (sections dédiées avec chiffres avant/après). Préciser que S1 prouve le mécanisme de **réservation** (un exemplaire est consommé au claim, pas à la fin du téléchargement) et rappeler la définition de T1.  
**5.4 Description de l'API**  
Fichier OpenAPI (REST) + spécification des messages WebSocket (types, champs, codes d'erreur). Assez précis pour que le jury écrive son propre test :  
  
|  |  |  
| - | - |  
| **Endpoint** |  **Rôle** |  
| `POST /session` |  nom + e-mail → JWT |  
| `POST /ws-ticket` |  ticket à usage unique (60 s) pour ouvrir le WebSocket |  
| `POST /documents/{id}/updates`, `GET /documents/{id}/updates?since={seq}` |  repli HTTP de l'édition (mêmes updates Yjs, mêmes règles de crédit) |  
| `GET /me/credit` |  crédit restant du jour |  
| `POST /documents`, `GET /documents`, `GET /documents/{id}` |  créer / lister / lire |  
| `POST /documents/{id}/members` |  donner accès |  
| `GET /documents/{id}/versions`, `POST /documents/{id}/versions/{n}/restore` |  historique / restauration |  
| `POST /documents/{id}/links` |  créer un lien (`maxDownloads`) |  
| `GET /d/{token}/status` |  état public (cache court) |  
| `POST /d/{token}/claim` |  réserver un exemplaire (idempotent via `visitorId` : un retry renvoie le même ticket, même quota épuisé) |  
| `GET /d/{token}/file` |  URL présignée du PDF (ou `waiting`) |  
| `GET /admin/state` |  supervision (clé admin) |  
| WebSocket |  messages **JSON** : `join`, `update` (`{opId, update}` en Base64), `awareness`, `ack`, `presence`, `error` (`CREDIT_EXHAUSTED`, `BLOCKED`, `FORBIDDEN`) |  
  
   
Réponses visiteur normalisées : `ready` (200 + URL) · `waiting` (202 + `retryAfter`) · `exhausted` (410).  
Exemple de message WebSocket d'écriture :  
```  
{"type":"update","opId":"op_12345","documentId":"doc_123","payload":"<update Yjs en Base64>"}  
   
```  
**5.5 Preuve de coût**  
- Captures **Billing / Cost Explorer** (par service, période du week-end), capture de la configuration **Budgets**  
- Estimation via AWS Pricing Calculator pour une année d'usage hypothétique, pour montrer que tu sais raisonner sur le coût  
- Rappel : à générer **lundi 06h00 → 07h30** et à commiter avant 07h30 ; les données de facturation peuvent être incomplètes, donc compléter par le calcul à partir des métriques d'usage  
  
---  
**6. Sécurité et bonnes pratiques — liste de contrôle**  
- Aucune clé d'accès AWS dans le code ni l'historique Git (scan `gitleaks` complet avant rendu)  
- Rôles IAM par fonction, actions et ressources ciblées (pas de `*`)  
- Secrets (JWT, clé admin) dans SSM Parameter Store  
- Buckets S3 : accès public bloqué, chiffrement, accès via CloudFront OAC / URL présignées  
- URL présignées : 60 secondes  
- Validation et taille maximale des entrées (updates ≤ 16 Ko de binaire, noms, e-mails) ; limites de débit sur API Gateway  
- WebSocket : ticket à usage unique en query string, **query string exclue des logs d'accès** ; limite résiduelle documentée dans les ADR  
- Journaux CloudWatch avec rétention courte (1–7 jours) pour limiter le coût  
- Étiquettes (`tags`) sur toutes les ressources pour la preuve de coût et le nettoyage  
- Une seule région, vérifiée dans le template  
  
---  
**7. Risques principaux**  
  
|  |  |  |  
| - | - | - |  
| **Risque** |  **Impact** |  **Parade** |  
| Plafond de concurrence Lambda très bas |  C5 impossible |  Vérifier en phase 0 ; demande d'augmentation ; cache CloudFront du `status` ; chemin de claim minimal |  
| Partition chaude sur le compteur du lien |  Écritures refusées |  Lecture de garde avant écriture ; court-circuit une fois `EXHAUSTED` ; \~200 req/s reste sous la limite d'une clé |  
| Update Yjs trop gros |  Connexion fermée (limite de trame 32 Ko) |  Plafond 16 Ko de binaire (Base64 +33 %) côté serveur et client + regroupement `BATCH_MS` + compaction |  
| Trames binaires envoyées au WebSocket |  Connexion fermée (code 1003) |  JSON + Base64 uniquement ; test de taille dès 2 clients |  
| Retries (claim, update) |  Exemplaire ou crédit consommé deux fois |  `visitorId` et `opId`, vérification du ticket avant et après échec de transaction |  
| Trou dans les `seq` / update perdu |  Modification acceptée non récupérable |  Transaction unique (`seq` + update + crédit + `opId`) : aucun trou possible ; S2 vérifie des `seq` contigus |  
| Contention sur le compteur `seq` d'un document |  Conflits, latence |  `commitBatch`, file SQS FIFO par document (phase 2b), palier réellement atteint rapporté honnêtement |  
| Fan-out WebSocket quadratique (300 rédacteurs, 1 document) |  Lambda saturée, latence |  Regroupement client (`BATCH_MS`) et diffusion par lots, quota `@connections` vérifié en phase 0, montée progressive en S2 |  
| Génération PDF lente |  Visiteurs en attente longue |  Génération asynchrone, cache par version, mesure sur gros document |  
| SES en bac à sable |  Aucun e-mail pour le jury |  Demande d'accès production en phase 0 |  
| Règle « Travail individuel » interprétée (IA implicitement autorisée) |  Contestation |  Usage d'un assistant IA déclaré dans le README ; bibliothèques open source confirmées |  
| Phase 2 qui s'enlise |  Tout le reste décale |  Point de contrôle samedi 21h30, repli HTTP, plafond 4 h |  
| Perte des logs à la suppression |  Pas de preuve des tests |  Export des résultats bruts avant `sam delete` |  
| Connexions WebSocket orphelines |  Diffusion en erreur |  Nettoyage sur 410 + TTL |  
| Dépassement de budget |  Facture |  Alertes Budgets, rétention logs courte, `sam delete` après la correction par le jury |  
| Retard sur la phase 2 ou 4 |  Contraintes éliminatoires non prouvées |  Appliquer la liste de coupes (section 3), ne jamais couper C1–C4 |  
  
   
  
---  
**8. Checklist finale (dimanche soir / lundi)**  
- S1 et S2 réussis, résultats bruts **et logs** archivés avant toute suppression  
- README exécuté de zéro sur un déploiement propre  
- Dossier de conception, rapport de test, description d'API relus  
- Preuves de coût capturées  
- Procédure de suppression testée (README) ; exécutée seulement après la correction  
- Dépôt propre : pas de secrets, pas de fichiers inutiles  
