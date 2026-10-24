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
   auraient échoué : les `Handler:` visaient des fonctions internes (`documents.listHandler`)
   que les bundles n'exportaient pas.
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

## Preuves exécutées

```
typecheck backend ......... OK (0 erreur)
tests unitaires .......... 29/29
mode local (E2E) ......... 20/20 — WebSocket natif, PDF réel, quota, crédit
typecheck frontend ....... OK
build Next ............... 8 pages statiques
template CloudFormation .. YAML valide, 20 ressources
```

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
