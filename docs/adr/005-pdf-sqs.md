# ADR 005 — PDF asynchrone via SQS, construit à la version figée (T1)

**Statut :** accepté · **Date :** 2026-10-24

## Contexte

C3 impose que le lien donne le document **tel qu'il est au moment où le visiteur
s'en sert**, complet et cohérent, sans créer un nouveau lien. C5 impose que 500
visiteurs simultanés obtiennent une réponse. Or la génération d'un PDF de
100 000 caractères prend plusieurs secondes.

## Décision

1. **Définition de T1** : l'instant où le serveur fige la version est la
   **lecture du dernier `seq` écrit au début du claim**. Ce `seq` est stocké dans
   le ticket (`seqFrozen`) et ne change plus.
2. **Génération asynchrone** : le claim arme le verrou `PdfCache` (Put
   conditionnel `attribute_not_exists`) et publie **un seul** message SQS. Tous
   les visiteurs, y compris celui qui a publié, reçoivent `202 waiting`.
3. **Worker séparé** (`editeur-worker`, long polling 20 s, visibilité 120 s,
   file de lettres mortes après 3 essais) : `pdfkit` et la reconstruction Yjs
   sont gourmands en CPU, les isoler protège la boucle d'événements du serveur.
4. **Reconstruction** : snapshot ≤ `seqFrozen` + entrées de journal ≤ `seqFrozen`,
   jamais le texte courant au moment où le worker s'exécute.
5. **Clé S3 déterministe** : `pdf/{docId}/v{seq}.pdf`. Le worker est donc
   idempotent : rejouer un message réécrit le même objet.
6. **Livraison** : URL présignée de 60 s, bucket privé.

## Justification

- **Cohérence** : un visiteur qui réserve à T1 reçoit le document à T1, même si
  200 modifications arrivent ensuite. C'est exactement l'énoncé de C3.
- **Aucune attente dans la requête** : le visiteur reçoit un état explicite
  (`waiting`) au lieu d'un timeout.
- **Mutualisation** : 500 visiteurs au même instant = **un** PDF généré, grâce au
  verrou et au cache par version.
- **Lettres mortes** : un PDF impossible (document supprimé, données corrompues)
  ne tourne pas en boucle ; après 3 échecs le visiteur reçoit un message clair.

## Alternatives écartées

| Alternative | Raison du rejet |
| - | - |
| PDF produit à la création du lien | Viole C3 : le document évolue après l'annonce |
| Génération synchrone dans le claim | Le visiteur attend ; risque de timeout et de 500 générations inutiles |
| Chromium headless | Lourd, lent, cher, inutile pour du texte brut |
| Cache par `docId` seul | Servirait un PDF obsolète après modification |

## Conséquences

- Un visiteur voit au plus deux états (`waiting`, puis `ready`) : il n'est
  jamais « jeté ».
- Le bail (`leaseUntil`, 120 s) permet de relancer une génération abandonnée par
  un worker tué (crash, redéploiement).
- Après 3 échecs, `FAILED` fait répondre `503` avec un message explicite plutôt
  qu'un `waiting` éternel.
