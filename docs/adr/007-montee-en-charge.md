# ADR 007 — Montée en charge d'un même document

**Statut :** accepté, avec réserve mesurée · **Date :** 2026-10-24

## Contexte

La cible est de 300 rédacteurs dans un **même** document. Deux goulots apparaissent :

1. **Le compteur `seq`** : une transaction conditionnelle par update sérialise les
   écritures d'un même document.
2. **Le fan-out** : chaque update diffusé à *n* connexions coûte *n* appels
   `postToConnection`. À 300 rédacteurs et 1 update/s, cela ferait ~90 000 appels/s.

## Décision

Trois leviers, appliqués par ordre de coût/bénéfice :

1. **Regroupement client** (`BATCH_MS = 300` ms) : les frappes deviennent un seul update
   (`Y.mergeUpdates`). C'est le levier le plus rentable : il divise simultanément le
   nombre de transactions et le fan-out.
2. **Diffusion par lots** de 25 connexions, en parallèle borné, avec purge des connexions
   mortes (`410`).
3. **Point d'extension `commitBatch`** : la transaction est isolée dans
   `commitUpdate` / `stateFromJournal`, de sorte qu'un lot de N updates puisse devenir une
   transaction (`seq += N`) et qu'une file SQS FIFO (`MessageGroupId = docId`) puisse
   déplacer le problème vers la latence.

## Justification

- Le regroupement est **nécessaire** dans tous les cas : sans lui, le fan-out seul
  saturerait le quota `@connections`.
- La file SQS FIFO n'est **pas** activée par défaut : elle ajoute une latence et une
  complexité (ack asynchrone) qui ne se justifient que si les mesures S2 montrent un taux
  de conflits élevé.
- Le palier réellement atteint doit être **rapporté honnêtement** dans le rapport de test,
  conformément à la règle du sujet (« application simple mais justifiée »).

## Alternatives écartées

| Alternative | Raison du rejet |
| - | - |
| Verrou par document côté client | Un client défaillant bloque tout le monde |
| Un compteur par paragraphe | Complexifie le journal et la compaction, sans bénéfice prouvé |
| Diffusion non groupée | Coût quadratique : quota `@connections` dépassé |

## Conséquences

- Si S2 montre des conflits au palier 100, la prochaine étape est une file SQS FIFO par
  document, pas un changement de modèle de données.
- Le paramètre `BATCH_MS` est réglable (300 ms par défaut, jusqu'à 1 s sous forte charge)
  et sa valeur doit être justifiée par une mesure, pas par une intuition.
- La latence de propagation visée reste p95 < 1 s.
