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

## Preuves exécutées

```
typecheck backend ......... OK (0 erreur)
tests unitaires .......... 29/29
mode local (E2E) ......... 24/24 — WebSocket natif, PDF réel, quota, crédit, CORS
persistance locale ....... 7/7  — document, texte, lien, session, clé admin
typecheck frontend ....... OK
build Next ............... 8 pages statiques
template CloudFormation .. YAML valide, 20 ressources
```

> Le script E2E suppose un serveur **fraîchement démarré** : il crée un document et
> un lien, puis épuise ce lien. Lancé deux fois sans redémarrage, la seconde passe
> échoue sur le quota déjà consommé.

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
