# ADR 003 — Claim : garde en mémoire + transaction conditionnelle

**Statut :** accepté · **Date :** 2026-10-24

## Contexte

C1 est éliminatoire : un lien distribue **exactement** N exemplaires, jamais N+1,
quel que soit le nombre de visiteurs simultanés. C6 exige qu'une fois épuisé, le
lien réponde vite **sans continuer à travailler**. C5 impose d'encaisser
12 000 clics en 60 s.

## Décision

Trois couches, avec une séparation stricte des responsabilités :

1. **Court-circuit en mémoire** : si le lien est connu comme épuisé, réponse
   immédiate `exhausted`, sans aucun appel DynamoDB.
2. **Garde en mémoire** : un compteur de claims simultanés par lien
   (`MAX_CLAIMS_IN_FLIGHT`, 50 par défaut). Sans jeton disponible, le visiteur
   reçoit `202 waiting` — **jamais** `exhausted` : la garde ne décide pas du quota.
3. **Transaction DynamoDB conditionnelle** — seule **autorité** :
   - `Links` : `ADD remaining -1`, condition `remaining > 0 AND status = ACTIVE` ;
   - `Tickets` : Put du ticket, condition `attribute_not_exists(visitorId)`.

   La transition `ACTIVE → EXHAUSTED` est une écriture **séparée et idempotente**
   (`status = ACTIVE AND remaining = 0`) : sous concurrence, c'est le claim qui a
   réellement amené le compteur à 0 qui la pose.

## Ordre imposé (correction du plan v7, point 4.2-1)

`claim` cherche le ticket du `visitorId` **avant** le court-circuit `exhausted`.
Sans cela, un visiteur qui possède déjà son exemplaire recevrait `410` après
l'épuisement du lien — exactement le cas que C1 doit couvrir.

## Justification

- **C1 tient par la transaction** : la condition est évaluée par DynamoDB au
  moment de l'écriture. Aucune fenêtre de course, contrairement à un « lire puis
  écrire » applicatif.
- **C5 tient par la garde** : 12 000 clics en 60 s feraient 12 000 transactions
  sur la même clé. La garde en admet 50 à la fois et fait patienter le reste,
  ce qui est un état **explicite** autorisé par le sujet (« patienter »).
- **C6 tient par le double court-circuit** : mémoire d'abord, puis `remaining`
  qui fait foi. Le statut stocké peut être en retard d'un instant, jamais le
  compteur.
- **Idempotence** : la clé `(token, visitorId)` rend un retry inoffensif, y
  compris après épuisement ; `GET /file` renvoie le même ticket.

## Alternatives écartées

| Alternative | Raison du rejet |
| - | - |
| Compteur uniquement en mémoire | Un redémarrage perdrait le quota : C1 cassé |
| Compteur uniquement en base, sans garde | Throttling DynamoDB sur une clé unique à 200 req/s |
| `remaining` décrémenté par un worker | Le visiteur attendrait une confirmation ; latence et complexité inutiles |
| Répondre `429` sous charge | Interdit : le sujet exige « ni casser, ni jeter » |

## Conséquences

- Un visiteur qui patiente ne consomme **aucun** exemplaire (la réservation n'a
  lieu qu'au claim réussi).
- Le micro-cache nginx de `/status` (1 s) et le sondage client (3 s ±25 %)
  bornent le délai d'information « épuisé » ; mesuré par S6.
- `remaining` et `status` peuvent diverger d'un instant : tous les chemins de
  lecture se fient au **compteur**, jamais au seul statut.
