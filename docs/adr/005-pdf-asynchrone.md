# ADR 005 — PDF généré à la demande, asynchroniquement, avec cache par version

**Statut :** accepté · **Date :** 2026-10-24

## Contexte

C3 impose que le lien donne le document **tel qu'il est au moment de son utilisation**,
complet et cohérent, sans créer un nouveau lien. C5 impose que 500 visiteurs simultanés
obtiennent une réponse, alors qu'API Gateway HTTP coupe à 29 s.

## Décision

1. **Définition de T1** : l'instant où le serveur fige la version du document est la
   **lecture de `seq` au début du claim**. Ce `seq` est stocké dans le ticket
   (`seqFrozen`).
2. **Génération asynchrone** : le claim déclenche une Lambda en `InvocationType: Event`
   (jamais d'attente dans la requête HTTP) et répond immédiatement `202 waiting`.
3. **Cache par version** : la clé est `docId#seqFrozen`. Un seul claimant obtient le
   verrou `BUILDING` (écriture conditionnelle) ; **tous** les autres, lui compris,
   reçoivent `202 waiting` avec `Retry-After`.
4. **Reconstruction** : le PDF est produit à partir du **snapshot + updates ≤ seqFrozen**,
   jamais du texte courant au moment où la Lambda s'exécute.
5. **Livraison** : URL S3 présignée de **60 secondes**, bucket privé.

## Justification

- **Cohérence** : un visiteur qui réserve à T1 reçoit le document à T1, même si 200
  modifications arrivent entre-temps. C'est exactement l'énoncé de C3.
- **Absence de timeout** : la génération (mesurée sur 100 000 caractères) ne se fait
  jamais dans la requête du visiteur.
- **Mutualisation** : 500 visiteurs au même instant = **un seul** PDF généré. Sans cache,
  on générerait 500 fois le même fichier.
- **Livreurs** : `pdf-lib` en JavaScript pur, démarrage rapide, pas de Chromium headless.

## Alternatives écartées

| Alternative | Raison du rejet |
| - | - |
| PDF généré à la création du lien | Viole C3 : le document évolue après l'annonce |
| Génération synchrone dans le claim | Timeout API Gateway à 29 s, et 500 générations inutiles |
| Chromium headless | Lourd (démarrage, mémoire), cher, inutile pour du texte simple |
| Cache par `docId` seul | Servirait un PDF obsolète après modification |

## Conséquences

- Un visiteur voit au maximum deux états avant le téléchargement (`waiting` puis
  `ready`) : il **n'est jamais jeté** (exigence du sujet).
- Le cache expire avec la table (`TTL` de 7 jours) et le bucket (`30 jours`).
- Les PDF sont nommés avec le titre du document, assaini pour l'en-tête
  `Content-Disposition`.
