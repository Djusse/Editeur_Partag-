# ADR 006 — Crédit : comptage serveur depuis le binaire Yjs

**Statut :** accepté · **Date :** 2026-10-24

## Contexte

C4 impose qu'un rédacteur n'écrive jamais plus que 10 000 caractères par jour,
**même depuis plusieurs appareils**. Un comptage déclaré par le client serait
contournable en une ligne de JavaScript : la contrainte ne serait pas prouvée.

## Décision

Le serveur décode la **structure binaire** de l'update Yjs pour compter les
caractères, **sans reconstruire de `Y.Doc`** (`backend/src/lib/yjs-update.ts`).

Règles de facturation :

1. L'expéditeur authentifié est facturé de **toutes** les insertions et de
   **toutes** les suppressions de l'update, quel que soit le `clientID` qui a
   produit les structs (un `clientID` n'est pas une preuve d'identité).
2. Insertions = longueur des `ContentString`.
3. Suppressions = longueur des plages du **delete set**.
4. La **restauration de version est gratuite** : c'est un update système appliqué
   par le serveur (`chars: 0`), l'utilisateur ne fait que choisir une version.
5. Le débit se fait dans la **même transaction** que l'écriture du journal :
   jamais de crédit débité pour un update non persisté.
6. Déduplication : un `opId` rejoué renvoie l'`ack` d'origine **sans débit** ; un
   contenu identique sous un autre `opId` est reconnu par le hash SHA-256 et
   acquitté sans débit non plus. La fenêtre de déduplication est de 48 h (TTL
   `OpIds`), durée documentée.

## Justification

- **Incontournable** : le client envoie un update signé par sa session ; le
  serveur relit les octets. Il ne peut pas mentir sur la taille.
- **Pas de reconstruction** : lire la structure coûte quelques dizaines de
  microsecondes par update ; reconstruire un `Y.Doc` coûterait mémoire et CPU.
- **Surfacturation impossible** : rejouer du contenu ne peut que **sur**facturer,
  jamais sous-facturer. La garantie visée est « jamais plus de 10 000 caractères
  acceptés ».
- **Multi-appareils** : le compteur est indexé `email#jour UTC` : cinq onglets
  partagent le même quota. Vérifié par un test dédié.

## Alternatives écartées

| Alternative | Raison du rejet |
| - | - |
| Comptage déclaré par le client | Contournable : C4 non prouvée |
| Reconstruction d'un `Y.Doc` serveur | Coût CPU et mémoire inutiles à 300 rédacteurs |
| Compteur par `clientID` | Facilement contourné en changeant de `clientID` |
| Facturer seulement les insertions | Contredit la décision du tableau 1.4 (suppressions comptées) |

## Conséquences

- Le format d'update Yjs v1 est décodé manuellement : un changement de format
  casserait le comptage. C'est couvert par 7 tests unitaires générés avec la
  **vraie** bibliothèque Yjs (insertions, suppressions, update complet, unicode,
  update corrompu).
- Un update dépassant 64 Ko de binaire est refusé **avant** tout débit, avec le
  message dédié de l'interface.
- Le compteur d'abus est incrémenté au plus une fois par `opId` refusé, sinon un
  client qui s'acharne en boucle se bloquerait lui-même sans avoir réessayé.
- Au 4ᵉ refus de la journée UTC, `blockedUntil` = prochain minuit UTC : la
  lecture reste possible, l'écriture non.
