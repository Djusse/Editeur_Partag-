# ADR 004 — Fusion CRDT avec Yjs

**Statut :** accepté · **Date :** 2026-10-24

## Contexte

C2 exige qu'aucune modification acceptée ne soit perdue et que tous les
participants finissent par voir le même document, **y compris en écrivant au
même endroit**. Un verrou applicatif ne suffit pas : il faut que la fusion soit
correcte même si deux updates arrivent dans un ordre différent chez deux clients.

## Décision

**Yjs** avec un `Y.Text` nommé `content`, et un journal d'updates
**append-only** :

- chaque tick d'écriture reçoit un `seq` **total et contigu** par document ;
- le serveur **fusionne** les updates du tick (`Y.mergeUpdates`) mais ne réécrit
  jamais le passé ;
- le client rejoue les updates manquants à la reconnexion (`join {sinceSeq}`) ;
- un trou dans les `seq` est **anormal** et détectable : c'est un critère
  d'acceptation du rapport de test ;
- filet de sécurité : resynchronisation complète par `GET /documents/{id}/state`
  (état encodé par `encodeStateAsUpdate`).

## Justification

- **Commutativité** : la fusion CRDT est commutative, associative et idempotente.
  Rejouer un update ne change pas l'état — ce qui rend le renvoi sur non-`ack`
  sûr par construction.
- **Aucun verrou** : pas de « quelqu'un tient la main ». Le pire cas est une
  latence de fusion, jamais une perte.
- **Même bibliothèque côté serveur** : le comptage du crédit lit la structure
  binaire de l'update sans reconstruire de `Y.Doc` (ADR 006).
- **Écosystème** : `y-codemirror.next` fournit les curseurs et la présence.

## Alternatives écartées

| Alternative | Raison du rejet |
| - | - |
| OT (Operational Transformation) maison | Transformations par paire, cas limites innombrables, risque incompatible avec le délai |
| Verrou pessimiste | Contredit « écrire au même endroit » et crée un point chaud |
| Dernier écrivain gagne (`updatedAt`) | Perte de modifications : C2 échoue explicitement |

## Conséquences

- Le serveur facture **toutes** les insertions et suppressions d'un update, quel
  que soit le `clientID` qui l'a produit (un `clientID` n'est pas une preuve
  d'identité).
- La restauration de version ne réécrit pas le passé : elle **applique un nouvel
  update** qui remplace le texte, compatible avec l'historique.
- Le texte est volontairement **brut** (pas de formatage riche) : cela garde le
  PDF trivial et supprime toute une classe de bugs.
