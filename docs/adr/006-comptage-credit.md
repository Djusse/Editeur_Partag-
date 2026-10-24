# ADR 006 — Comptage du crédit côté serveur

**Statut :** accepté · **Date :** 2026-10-24

## Contexte

C4 impose qu'un rédacteur n'écrive jamais plus que 10 000 caractères par jour, **même
depuis plusieurs appareils**. Un comptage déclaré par le client serait contournable en
une ligne de JavaScript : la contrainte ne serait pas prouvée.

## Décision

Le serveur **décode la structure binaire** de l'update Yjs pour compter les caractères,
**sans reconstruire de `Y.Doc`** (`backend/src/lib/yjs-update.ts`).

Règles de facturation :

1. L'expéditeur authentifié est facturé de **toutes** les insertions et de **toutes** les
   suppressions de l'update, quel que soit le `clientID` qui a produit les structs (un
   `clientID` n'est pas une preuve d'identité).
2. Les insertions = longueur des `ContentString`.
3. Les suppressions = longueur des plages du **delete set**.
4. **La restauration de version est gratuite** : c'est un update système appliqué par le
   serveur (`chargeCredit: false`), l'utilisateur ne fait que choisir une version.
5. La déduplication repose sur la table `OpIds` (TTL 48 h), pas sur le
   `ClientRequestToken` de DynamoDB, qui ne couvre que 10 minutes.

## Justification

- **Incontournable** : le client envoie un update signé par sa session ; le serveur relit
  les octets. Il ne peut pas mentir sur la taille.
- **Pas de reconstruction** : lire la structure coûte quelques dizaines de microsecondes
  par update ; reconstruire un `Y.Doc` coûterait de la mémoire et du temps CPU facturé.
- **Surfacturation impossible** : rejouer du contenu ne peut que **sur**facturer, jamais
  sous-facturer. La garantie visée est « jamais plus de 10 000 caractères acceptés ».
- **Multi-appareils** : le compteur est indexé par `email#jour UTC` : cinq onglets
  partagent le même quota.

## Alternatives écartées

| Alternative | Raison du rejet |
| - | - |
| Comptage déclaré par le client | Contournable : C4 non prouvée |
| Reconstruction d'un `Y.Doc` serveur | Coût CPU et mémoire inutiles |
| Compteur par `clientID` | Facilement contourné en changeant de `clientID` |
| Facturer seulement les insertions | Contredit la décision documentée (suppressions comptées) |

## Conséquences

- Le format d'update Yjs v1 est décodé manuellement : tout changement de format casserait
  le comptage. C'est couvert par 7 tests unitaires générés avec la **vraie** bibliothèque
  Yjs (insertions, suppressions, update complet, unicode, update corrompu).
- Un update trop gros (> 16 Ko binaires) est refusé **avant** tout débit.
- Le compteur d'abus est incrémenté au plus une fois par `opId` refusé (marqueur
  `REFUSED#email#opId`), pour qu'un client qui s'acharne ne se bloque pas lui-même en
  boucle.
