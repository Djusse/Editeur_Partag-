# ADR 004 — Fusion par CRDT (Yjs)

**Statut :** accepté · **Date :** 2026-10-24

## Contexte

C2 exige qu'« aucune modification acceptée ne soit perdue » et que « tous les
participants finissent par voir le même document », **y compris en écrivant au même
endroit**. Un verrou applicatif ne suffit pas : il faut que la fusion soit correcte même
si deux updates arrivent dans un ordre différent chez deux clients.

## Décision

**Yjs** avec un `Y.Text` unique (`content`), et un journal d'updates **append-only** :

- chaque update reçoit un `seq` **total et contigu** par document ;
- le serveur ne fusionne pas : il ordonne et persiste ;
- le client applique les updates manquants à la reconnexion (`sinceSeq`);
- un trou dans les `seq` est détectable et donc **anormal** ;
- filet de sécurité : resynchronisation complète par `encodeStateAsUpdate` au chargement.

## Justification

- **Commutativité** : la fusion CRDT est commutative, associative et idempotente. Rejouer
  un update ne change pas l'état, ce qui rend le retry sûr.
- **Aucun verrou** : pas de « quelqu'un tient la main » ; le pire cas est une latence de
  fusion, jamais une perte.
- **Même bibliothèque côté serveur** : le comptage du crédit lit la structure binaire de
  l'update sans reconstruire de `Y.Doc` (voir ADR 006).
- **Écosystème** : `y-codemirror.next` fournit curseurs distants et présence.

## Alternatives écartées

| Alternative | Raison du rejet |
| - | - |
| OT (Operational Transformation) maison | Implémentation très risquée en un week-end (transformations par paire, cas limites) |
| Verrou pessimiste | Contredit « écriture au même endroit » et crée un point chaud |
| Dernier écrivain gagne (`updatedAt`) | Perte de modifications : C2 échoue explicitement |

## Conséquences

- Le serveur facture **toutes** les insertions et suppressions d'un update, quel que
  soient les `clientID` qui les composent : un `clientID` n'est pas une preuve d'identité.
- La restauration de version ne réécrit pas le passé : elle **applique un nouvel update**
  qui remplace le texte, compatible avec l'historique.
- Les en-têtes de formatage riches (XML) ne sont pas utilisés : un `Y.Text` simple suffit
  et garde le PDF trivial à produire.
