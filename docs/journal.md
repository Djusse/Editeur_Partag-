# Journal de décisions et de coûts

Alimenté au fil de l'eau : sert de matière première au dossier de conception et au
rapport de test.

## 2026-10-24 — Socle serverless (v6, abandonné)

| Heure (UTC) | Événement |
| - | - |
| 10:15 | Lecture du sujet et du plan v6 (Lambda + API Gateway) |
| 10:23 | Parseur d'updates Yjs validé contre la vraie bibliothèque |
| 10:45 | 26 tests unitaires verts (C1, C4) |
| 11:00 | Mode local sans AWS : 17 points du parcours vérifiés |
| 11:58 | Dépôt GitHub créé et poussé (`3aa88b3`, `e831f23`) |

## 2026-10-24 — Bascule vers la v7 (EC2), décision structurante

**Déclencheur :** le cours a couvert EC2 (TP 3 et 4), pas Lambda, API Gateway ni SAM.
Les quotas mesurés dans le compte sont par ailleurs défavorables au serverless :

| Quota mesuré (`eu-north-1`) | Valeur | Conséquence |
| - | - | - |
| Concurrence Lambda | 400 | partagée entre claims, polling et écritures : serré pour C5 |
| vCPU EC2 (A, C, D, H, I, M, R, T, Z) | 16 | marge confortable pour une instance applicative |

**Décision :** une instance EC2 (`t3.large`), Node.js 22, Fastify + `ws` + Yjs,
derrière nginx, avec l'état des documents **en mémoire**. CloudFormation remplace SAM.

## Ce qui a été réécrit

| Zone | Avant (v6) | Après (v7) |
| - | - | - |
| Calcul | 19 Lambda + API Gateway HTTP/WS | 1 instance, 1 processus Fastify + `ws`, 1 worker SQS |
| Écriture | transaction par update | **lot par tick de 250 ms**, écrivain unique |
| WebSocket | API Gateway (JSON + Base64, 16 Ko) | `ws` natif, JSON + Base64, **64 Ko** |
| Temps réel en local | impossible (repli HTTP seulement) | **testable réellement** |
| Présence, tickets ws | tables DynamoDB | **mémoire** (instance unique) |
| Secrets | générés à la volée | créés par `deploy.sh` en SSM, lus par le rôle d'instance |
| Front | thème sombre, styles inline | **thème clair**, jetons imposés, 3 modales, 5 pages |
| Identifiants d'API | `docId` | `id` (contrat d'interface), `documentId` côté WebSocket |
| Erreurs | `{error:{code,message}}` | `{error: "CODE", field?}` |

## Défauts trouvés et corrigés (les plus instructifs)

1. **Template pointant vers des handlers inexistants (v6).** Toutes les routes HTTP
   auraient échoué : les `Handler:` visaient des fonctions internes
   (`documents.listHandler`) que les bundles n'exportaient pas.
2. **`POST /documents` sur le handler de `GET`.** Créer un document aurait renvoyé
   une liste.
3. **Écriture impossible en repli HTTP (v6).** Le provider exigeait `synced` avant
   d'envoyer ; ce drapeau n'était posé que par le WebSocket.
4. **Transition `EXHAUSTED` non atomique.** Sous 50 claims concurrents pour N=20, le
   lien restait `ACTIVE` avec `remaining = 0` : le statut était calculé sur une
   lecture périmée. Corrigé par une écriture conditionnelle séparée, et les lectures
   se fient au **compteur**.
5. **Condition de crédit permissive.** `attribute_not_exists(used) OR …` laissait
   passer une première écriture au-dessus du plafond. Corrigé par
   `(attribute_not_exists(used) AND :chars <= :limit) OR (used + :chars <= :limit)`.
6. **Restauration qui dupliquait le texte.** La différence était calculée sur un
   `Y.Doc` vide, donc l'update ne contenait que des insertions. Corrigé : différence
   calculée sur l'état courant réel, préfixe/suffixe préservés.
7. **Un refus de crédit bloquait tout le lot.** Tous les auteurs étaient rejetés au
   lieu du seul fautif. Corrigé : l'auteur de chaque élément `Credits` est mémorisé,
   les `CancellationReasons` désignent l'indice fautif, les autres sont réécrits.
8. **Routes visiteur sous `/api`.** nginx sert `/` (statique) et proxifie `/api/` :
   les liens publics `/d?token=…` auraient renvoyé 404. Corrigé : le parcours visiteur
   est enregistré à la racine.
9. **Clé d'administration = secret JWT (mode local).** Les deux paramètres avaient le
   même nom, donc `/admin` refusait systématiquement. Corrigé par des noms distincts.
10. **`ADD` mal décodé dans le double en mémoire.** `[^S]` avec l'option `/i` excluait
    la lettre « s » et tronquait `:minusOne` : le quota ne se décrémentait pas.
11. **Aucun CORS dans le serveur Fastify (mode local).** Le front tourne sur
    `localhost:3000` et l'API sur `localhost:4000` : deux origines, donc le navigateur
    exige un préflight `OPTIONS` avec les en-têtes CORS. Fastify répondait `404` sans
    en-têtes, d'où « Connexion impossible » et « Impossible de charger l'état ».
    *Correction* : `@fastify/cors`, origines lues dans `WEB_ORIGIN`, en-têtes
    `content-type`, `authorization`, `x-admin-key`. En production, front et API
    partagent la même origine (nginx) : ce chemin n'est jamais emprunté.
    **Leçon** : un test E2E en Node ne voit pas ce bug, car `fetch` n'envoie pas de
    préflight. Le script vérifie donc désormais explicitement `OPTIONS`.
12. **Zone d'écriture vide et clavier inopérant.** `mountEditor` était appelé dans
    un `await`, **avant** que React n'ait rendu le `<div ref={host}>` : le garde
    `if (!host.current) return` sortait silencieusement, donc **aucun CodeMirror
    n'était créé**. *Correction* : le `Y.Doc` à monter est mis en attente
    (`attachPending`) et branché par un `useEffect` qui s'exécute **après** le
    rendu ; l'éditeur reçoit aussi le focus pour écrire sans clic préalable.
13. **Focus de la modale sur la croix de fermeture.** `autoFocus` est ignoré par
    React après le montage, et l'ordre du DOM place le bouton « × » avant le champ :
    chaque frappe atterrissait sur la croix. *Correction* : `Modal` privilégie
    `[data-autofocus]`, puis le premier champ de saisie, puis le premier élément
    focusable.
14. **Deux rédacteurs impossibles dans un même navigateur.** La clé `session` vivait
    dans `localStorage`, partagée par tous les onglets : changer d'identité dans l'un
    déconnectait l'autre, et « Mes documents » restait vide. *Correction* : la session
    active est celle du `sessionStorage` **de l'onglet**, `localStorage` servant de
    valeur par défaut pour un nouvel onglet.
15. **`.next` corrompu : « Cannot find module './819.js' ».** `next build` a été
    lancé **pendant** que `next dev` tournait ; les deux écrivent dans `.next`, qui
    s'est retrouvé avec un mélange de manifestes de production et de développement.
    *Correction* : arrêt du serveur, suppression de `.next`, redémarrage.
    **Règle retenue** : ne jamais lancer `npm run build` tant que `next dev` tourne.
    Le build de vérification se fait serveur arrêté, ou après `rm -rf .next`.
16. **« Les liens expirent » — en réalité, ils disparaissaient.** Le mode local
    stockait tout en mémoire : chaque redémarrage de l'API effaçait documents,
    liens **et sessions**. Un lien copié devenait alors « inconnu », ce qui
    ressemblait à une expiration. *Correction* : persistance sur disque
    (`.local-data.json`, écrite de façon atomique et avec débounce), incluant les
    **secrets** — sans eux, chaque démarrage invalidait toutes les sessions JWT et
    changeait la clé d'administration. Vérifié par `backend/test-persistence.mjs`
    (7 points : document, texte, lien, session, clé admin après redémarrage).
17. **La zone de saisie tremblait à chaque frappe.** Le bandeau « N modification(s)
    en attente d'enregistrement » était **dans le flux** : son apparition décalait
    le papier de 32 px, ce qui déplaçait le curseur pendant qu'on tapait.
    *Correction* : indicateur **flottant** (`position: fixed`, `pointer-events: none`),
    qui ne modifie jamais la mise en page. L'animation est désactivée sous
    `prefers-reduced-motion`.
18. **« Aucune version enregistrée » alors que l'on écrit.** `maybeSnapshot`
    déposait bien le snapshot dans S3, mais **n'ajoutait aucune ligne dans la
    table `Versions`** : seule la restauration appelait `saveVersion`. La modale
    était donc structurellement toujours vide. *Correction* : un snapshot crée
    désormais **aussi** la version consultable (même `seq`, même clé S3), et un
    endpoint `POST /documents/{id}/versions` permet d'en enregistrer une à la
    demande. Écart assumé par rapport à la spécification (qui ne prévoyait aucun
    bouton) : sans lui, un document neuf n'a aucune version à restaurer, alors que
    le sujet exige de pouvoir « consulter les versions et en restaurer une ».
    Vérifié par `backend/test-versions.mjs` (11 points).
19. **Aucun accès à la supervision depuis l'interface.** `/admin` existait mais
    n'était lié nulle part : le lien est ajouté dans la barre supérieure et sur la
    page d'entrée.
20. **« Ce lien n'existe pas ou n'est plus valide » sur un lien valide.**
    Le serveur expose le parcours visiteur à la **racine** (`/d/...`), mais le
    client préfixait par `/api` : `GET /api/d/{token}/status` → `404`. L'API
    répondait pourtant correctement sur `/d/{token}/status`. *Correction* : une
    constante `VISITOR_BASE` dérivée de `API_BASE` en retirant le suffixe `/api`
    (`''` en production, `http://localhost:4000` en développement).
    Vérifié par `backend/test-visitor-routes.mjs` (7 points) : la route correcte
    répond, la route fautive renvoie bien 404, ce qui documente le contrat.
    **Leçon** : mes tests E2E appelaient l'API directement, ils ne voyaient donc
    pas une erreur de construction d'URL côté client.
21. **Interface non responsive.** La barre supérieure et la barre d'outils de
    l'éditeur étaient en styles inline à hauteur fixe : sur mobile, le titre
    passait sur deux lignes et les boutons chevauchaient le contenu. *Correction* :
    classes `.topbar` / `.doc-toolbar` avec points de rupture à 768 px (identité et
    lien « Supervision » masqués, jauge compactée, actions en ligne défilante,
    colonne de présence masquée, `overflow-x: hidden` sur `body`).
22. **Téléchargement du PDF en 404.** Le bouton apparaissait, puis
    `GET http://localhost:3000/files/pdf/{docId}/v{seq}.pdf` renvoyait 404, alors
    que le même chemin sur le port 4000 répondait 200. Le magasin d'objets local
    renvoyait une URL **relative** (`/files/...`) : le navigateur la résolvait sur
    l'origine de la page, c'est-à-dire le front (3000), qui ne sert pas les PDF.
    En production, S3 renvoie toujours une URL absolue — le bouchon ne respectait
    donc pas le contrat `ObjectStore.presign`. *Correction* : `LocalStore` reçoit
    `baseUrl = http://localhost:{PORT}` et construit une URL absolue.
    Vérifié par `backend/test-link-real.mjs`, qui contrôle explicitement
    `^https?://` sur l'URL renvoyée, puis la télécharge réellement (13/13).
    **Leçon, la même que pour le défaut 20** : un bouchon local qui ne respecte pas
    le contrat de l'implémentation réelle fabrique de faux bugs — et mes tests
    validaient le serveur, pas l'usage que le navigateur fait de la réponse.
23. **« Impossible de charger vos documents » — toutes les requêtes en 404.**
    Symptôme : `GET http://localhost:3000/me/credit` et
    `GET http://localhost:3000/documents/undefined/` en 404 dans la console, alors
    que `GET http://localhost:4000/api/me/credit` répondait (401 sans jeton).
    Deux causes cumulées, toutes deux dans la configuration du client :
    - `next.config.mjs` contenait un bloc `env` qui réécrivait
      `NEXT_PUBLIC_API_BASE: process.env.NEXT_PUBLIC_API_BASE ?? ''`. Sans
      variable définie, Next recevait donc une chaîne **vide**, qui écrasait le
      défaut `'/api'` écrit dans `src/lib/api.ts` ;
    - le code utilisait `process.env.NEXT_PUBLIC_API_BASE ?? '/api'`, or `??` ne
      se déclenche que sur `null`/`undefined` : une chaîne vide était conservée.
      La base valait `''`, donc `fetch('') + '/me/credit'` partait sur l'origine
      de la page — le port 3000, qui ne sert pas l'API.
    *Correction* : suppression du bloc `env` (les `NEXT_PUBLIC_*` sont de toute
    façon inlinées par Next) et passage à `||` avec normalisation de la barre
    finale. Ajout d'un `console.warn` explicite quand la base vaut `/api` hors
    production, et d'un garde-fou qui refuse un chemin contenant `/undefined`
    (l'identifiant manquant était masqué par un 404 serveur).
    Vérifié par `tests/node/verify-client-bundle.mjs` (8 points en développement,
    4 en production) : il inspecte les chunks compilés et refuse une base vide,
    une URL `localhost` dans un build de production, ou un bundle qui vise le
    mauvais port. **C'est le premier test du projet qui vérifie le client et non
    le serveur** — les trois défauts de cette famille (20, 22, 23) sont passés
    inaperçus précisément parce que tous mes tests interrogeaient l'API.

24. **« L'application bug » quand le crédit s'épuise.** Symptôme observé : trois
    toasts identiques empilés, « Reconnexion… » clignotant, et le texte en cours
    qui disparaît. Le texte qui s'efface est **conforme** à la spécification
    (9.5 : un update refusé n'est jamais visible des autres, on reconstruit donc
    depuis le serveur). En revanche la boucle était un vrai défaut :
    `protocol.ts` renvoie `readOnly` **à chaque** `joined`, y compris ceux de
    `join {sinceSeq}`, et `provider.ts` traitait chacun comme un rejet. Or
    `handleRejection` → `onRejection` → `rebuildFromServer` → `provider.destroy()`
    → reconnexion → nouveau `joined` → nouveau rejet : boucle infinie.
    Deux aggravations : `this.readOnly` n'était jamais mis à `true`, et le refus
    n'annonçait pas `creditRemaining`, donc la jauge restait figée à
    « 1 / 10 000 » tout en refusant la frappe.
    *Correction* : mémorisation du code de rejet (`rejectionCode`) pour ne
    rejouer la procédure qu'une fois, `readOnly` réellement positionné, file et
    tampon vidés (mémoire **et** `localStorage`, 9.5 étape 1), `creditRemaining`
    ajouté à `joined` et relayé jusqu'à la jauge. Vérifié par
    `backend/test-credit-exhaustion.mjs` (19 points).
25. **Le PDF téléchargé s'appelait « v1.pdf ».** Le nom est porté par le
    paramètre `?filename=` de l'URL présignée ([`links.ts`](backend/src/lib/links.ts:259)),
    mais [`LocalStore.presign`](backend/src/local/main.ts:70) le laissait en
    paramètre : le navigateur nomme d'après le **dernier segment du chemin**, ici
    `v1.pdf`. S3, lui, utilise `ResponseContentDisposition`. *Correction* : la
    route `/files/*` du mode local pose un `Content-Disposition` conforme à la
    RFC 6266 (`filename` ASCII de repli + `filename*` UTF-8 pour les accents), et
    le lien de secours du visiteur reçoit `download="{titre}.pdf"` — sans valeur,
    sur la même origine (production), le navigateur ignorerait l'en-tête.
    `slug()` conserve désormais accents et casse (`Rapport final — Été 2026.pdf`)
    au lieu de tout réduire en minuscules sans accents.

26. **Le blocage n'existait que côté serveur.** Le compteur de refus et le
    verrou (`4 refus → BLOCKED jusqu'à minuit UTC`, C4) fonctionnaient et étaient
    testés depuis le début : `recordCreditRefusal` incrémente `Abuse[email#jour]`
    avec un marqueur `REFUSED#` par `opId`, donc un `opId` rejoué ne compte
    qu'une fois. Mais **rien ne l'annonçait** : l'utilisateur bloqué voyait un
    éditeur inerte et un bandeau discret. *Correction* : page `/bloque` dédiée
    (cause, terme exact, compte à rebours, « Continuer en lecture seule »,
    « Changer d'identité »), vers laquelle on redirige dans trois cas —
    connexion avec crédit déjà bloqué, ouverture de la liste des documents, et
    4ᵉ refus pendant l'édition. Le blocage expire seul : la page se rafraîchit et
    se redirige vers `/documents` sans action serveur.
    **On ne déconnecte pas.** La spécification (9.6) autorise explicitement la
    lecture pendant le blocage ; couper la session obligerait à ressaisir son
    identité pour relire un document, ce qui n'apporte aucune sécurité
    supplémentaire (aucun mot de passe, l'identité est déclarative).

## Preuves exécutées

```
typecheck backend ......... OK (0 erreur)
tests unitaires .......... 29/29
mode local (E2E) ......... 24/24 — WebSocket natif, PDF réel, quota, crédit, CORS
persistance locale ....... 7/7   — document, texte, lien, session, clé admin
versions ................. 11/11 — enregistrement, liste, restauration gratuite
routes visiteur .......... 7/7   — /d/... à la racine, /api/d/... en 404
lien réel (bout en bout) .. 13/13 — statut, claim, PDF, URL absolue, quota
épuisement crédit ........ 19/19 — décompte exact, refus, non-journalisation, blocage
bundle client (dev) ....... 8/8   — base API et WebSocket inlinées, routes réelles
bundle client (prod) ...... 4/4   — chemin relatif /api, aucune URL localhost
typecheck frontend ....... OK
build Next ............... 8 pages statiques (dont /bloque)
template CloudFormation .. YAML valide, 20 ressources
```

> Le script E2E suppose un serveur **fraîchement démarré** : il crée un document et
> un lien, puis épuise ce lien. Lancé deux fois sans redémarrage, la seconde passe
> échoue sur le quota déjà consommé.

> **Ordre d'arrêt important** : `SIGTERM` déclenche une sauvegarde de
> `.local-data.json`. Pour repartir d'un état vierge, il faut donc **tuer le
> serveur d'abord**, puis supprimer le fichier — sinon il est recréé à l'arrêt.

## Coûts

À compléter après les tests de charge, à partir de Cost Explorer **et** des métriques
d'usage (la facturation a ~24 h de retard).

| Poste | Mesure | Estimation |
| - | - | - |
| EC2 t3.large (heures) | à mesurer | — |
| Elastic IP (IPv4 publique) | à mesurer | — |
| DynamoDB (WRU/LRU à la demande) | à mesurer | — |
| S3 (stockage et requêtes) | à mesurer | — |
| SQS (messages PDF) | à mesurer | — |
| SES (e-mails) | quelques unités | négligeable |
| Instance de charge k6 | à mesurer | — |
