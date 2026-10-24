# Journal de décisions et de coûts

Ce journal est alimenté au fil de l'eau : il sert de matière première au dossier de
conception et au rapport de test.

## 2026-10-24 — Mise en place

| Heure (UTC) | Événement | Décision / preuve |
| - | - | - |
| 10:15 | Lecture du sujet et du plan v6 | Stack confirmée : Next.js export statique + Lambda TypeScript + SAM |
| 10:18 | Dépendances backend installées (97 paquets) | `@aws-sdk/*`, `lib0`, `pdf-lib`, `yjs` (test) |
| 10:23 | **Parseur d'updates Yjs validé** | 7 tests contre la vraie bibliothèque : insertions, suppressions, unicode, update corrompu |
| 10:24 | Bibliothèques pures écrites | Claim, crédit, updates, PDF, versions, liens |
| 10:29 | `tsc --noEmit` : 0 erreur | Aucune erreur de typage sur 22 fichiers backend |
| 10:32 | Template SAM validé | 48 ressources, 18 fonctions, une seule région (`eu-west-3`) |
| 10:39 | Build Next.js (export statique) | 8 pages pré-rendues, bundle éditeur 135 ko (Yjs + CodeMirror) |
| 10:45 | Bundling esbuild des handlers | `ws.js` = 39,5 ko ; `pdf.js` = 1,2 Mo (pdf-lib), acceptable |
| 10:45 | **26 tests unitaires passent** | C1 et C4 prouvés hors cloud |
| 10:51 | Cohérence template ↔ bundles vérifiée | 19 fonctions, 19 handlers présents |
| 10:54 | **33 tests unitaires passent** | Ajout de 7 tests sur la restauration de version |

## Défauts trouvés par les tests (et corrigés)

Ces anomalies sont documentées car elles sont la meilleure preuve que les tests servent à
quelque chose.

1. **Transition `EXHAUSTED` non atomique (C1).** Le statut était calculé à partir d'une
   valeur lue avant la transaction ; sous 50 claims concurrents pour N=20, le lien restait
   `ACTIVE` avec `remaining = 0`. *Correction* : le décrément est seul dans la transaction,
   et la transition `ACTIVE → EXHAUSTED` est une écriture conditionnelle séparée
   (`status = ACTIVE AND remaining = 0`), donc idempotente et monotone. `linkStatus` se
   fie aussi à `remaining`.
2. **Condition de crédit permissive sur un compteur absent (C4).**
   `attribute_not_exists(used) OR used + :delta <= :limit` laissait passer une première
   écriture supérieure au plafond. *Correction* : `(attribute_not_exists(used) AND :delta
   <= :limit) OR (used + :delta <= :limit)`.
3. **Format d'update Yjs mal décodé.** Le discriminant n'est pas le bit 128 mais
   `info & 31` (0 = GC, 10 = Skip), et `parentInfo` vaut 1 pour une clé racine.
   *Correction* : décodage aligné sur `yjs/src/utils/encoding.js`.
4. **Restauration qui dupliquait le texte.** La différence était calculée sur un
   `Y.Doc` vide, donc l'update ne contenait que des insertions : appliqué au vrai
   document, il **ajoutait** le texte au lieu de le remplacer. *Correction* :
   différence calculée sur l'état courant réel, préfixe/suffixe préservés ;
   7 tests dédiés (`test/versions.test.ts`).
5. **Journal tronqué (violation possible de C3).** `listUpdatesSince` s'arrêtait à
   1 000 éléments et `maybeSnapshot` n'était jamais appelé : au-delà de 1 000
   modifications, un PDF aurait été **incomplet** et `latestSnapshotSeq` serait resté
   à 0. *Correction* : pagination jusqu'au bout (bornée par `maxPages`), appel de
   `compactIfNeeded` après chaque écriture acceptée.
6. **Yjs absent des bundles (échec au déploiement).** `stateFromJournal` chargeait
   Yjs par `require()` dynamique : esbuild ne le résolvait pas, et `yjs` n'était
   qu'une `devDependency`. En Lambda (seuls les bundles sont déployés), l'appel aurait
   levé `MODULE_NOT_FOUND`. *Correction* : import statique + `yjs` en dépendance de
   production. Vérifié : aucun `require("yjs")` non résolu dans `dist/handlers/`.
7. **Template pointant vers des fonctions internes.** Les `Handler:` du template
   visaient `documents.listHandler`, `links.createHandler`, `updates.postHandler`…
   Ces noms **n'étaient pas exportés** par les bundles : toutes les routes HTTP
   auraient renvoyé une erreur d'initialisation. *Correction* : chaque fichier de
   handler exporte des handlers Lambda wrappés (`httpHandler`), et le template les
   référence (`documents.list`, `links.create`, …).
8. **`POST /documents`, `PATCH` et `DELETE` sur le handler de `GET`.** La création
   d'un document aurait répondu comme une liste. *Correction* : trois fonctions
   distinctes (`DocumentsCreateFunction`, `DocumentWriteFunction`,
   `DocumentDeleteFunction`).
9. **Écriture impossible en repli HTTP.** Le provider exigeait `synced` avant
   d'envoyer quoi que ce soit ; comme ce drapeau n'était posé que par le WebSocket,
   aucune modification ne partait lorsque le WebSocket était indisponible.
   *Correction* : bascule immédiate en repli + envoi sans attendre `synced`.

Les défauts 7 à 9 ont été trouvés en construisant le **mode local**
([`docs/developpement-local.md`](developpement-local.md)), qui exécute les vrais
handlers sans AWS : 17 points du parcours vérifiés, dont le PDF réel.

## Coûts

À compléter à la fin des tests de charge, à partir de Cost Explorer **et** des métriques
d'usage (les données de facturation ont jusqu'à 24 h de retard).

| Poste | Mesure | Estimation |
| - | - | - |
| Lambda (invocations × durée × mémoire) | à mesurer | — |
| DynamoDB (WRU/LRU à la demande) | à mesurer | — |
| API Gateway (HTTP + WebSocket, messages) | à mesurer | — |
| S3 (stockage PDF, requêtes) | à mesurer | — |
| CloudFront (requêtes, transfert) | à mesurer | — |
| SES (e-mails) | quelques unités | négligeable |
