# Spécification des messages WebSocket

## Connexion

```
ws://<elastic-ip>/ws?ticket=<ticket>&documentId=<docId>
```

En HTTPS, le schéma serait `wss:` : le front le déduit de `location`, il n'est
jamais écrit en dur.

1. Le client obtient un ticket par `POST /api/ws-ticket` (corps
   `{documentId}`, réponse `{ticket, expiresIn, documentId}`). L'accès au
   document est vérifié **à l'émission**.
2. Le ticket vaut **60 secondes** et n'est utilisable **qu'une seule fois**.
3. nginx transmet `Upgrade` et `Connection` (carte `$connection_upgrade`).

## Format

- **JSON uniquement** ; aucune trame binaire.
- Les updates Yjs voyagent en **Base64**.
- **Plafond : 64 Ko de binaire** par update. Un update Yjs est un bloc
  **indécoupable** : le client ne le scinde jamais. En pratique, le crédit limite
  l'insertion à 10 000 caractères par jour, donc un update dépasse rarement
  quelques Ko.

## Messages client → serveur

### `join`

```json
{ "type": "join", "documentId": "doc_ab12", "sinceSeq": 142 }
```

`sinceSeq` = `seq` reçu par `GET /api/documents/{id}/state`, ou le dernier `seq`
d'un `ack`/`update`. Le serveur renvoie les updates manquants, puis un `joined`.

### `update`

```json
{ "type": "update", "opId": "op_8f14e45f-…", "documentId": "doc_ab12", "payload": "<Base64>" }
```

| Champ | Contrainte | Rôle |
| - | - | - |
| `opId` | 1–100 caractères | Identifiant **stable** : un renvoi réutilise le même |
| `payload` | ≤ 64 Ko de binaire | Update Yjs en Base64 |

### `awareness` *(optionnel)*

```json
{ "type": "awareness", "documentId": "doc_ab12", "payload": "<Base64>" }
```

`payload` est un update du protocole `y-protocols/awareness` encodé en Base64
(pas un JSON `{cursor}`). Plafonné à 16 Ko ; ignoré au-delà.

### `ping`

```json
{ "type": "ping" }
```

Réponse : `{ "type": "pong", "at": 1700000000000 }`.

## Messages serveur → client

### `joined`

```json
{
  "type": "joined",
  "documentId": "doc_ab12",
  "seq": 142,
  "you": { "email": "awa@exemple.cm", "name": "Awa", "color": "#2563EB" },
  "creditRemaining": 7420,
  "resetsAt": "2026-10-25T00:00:00.000Z"
}
```

Après un `join`, le message porte aussi `caughtUp: <nombre d'updates renvoyés>`.

`creditRemaining` et `resetsAt` sont **toujours** présents : ils permettent au
rédacteur d'afficher une jauge exacte dès l'ouverture, sans appel
supplémentaire. Sans eux, la jauge restait à sa dernière valeur connue alors que
le crédit pouvait déjà être épuisé.

Si l'écriture est impossible, `readOnly` contient le code (`CREDIT_EXHAUSTED`,
`BLOCKED`, `FORBIDDEN`) et `blockedUntil` accompagne `BLOCKED`.

**Le serveur renvoie `readOnly` à chaque `joined`, y compris ceux de `join`.**
Le client ne doit rejouer la procédure de rejet (section 9.5) qu'**une seule
fois** : mémoriser le code reçu, sinon chaque reconnexion déclenche une
reconstruction du document, qui rouvre une connexion, qui renvoie `readOnly`…
boucle infinie.

### `update`

```json
{ "type": "update", "seq": 143, "documentId": "doc_ab12", "payload": "<Base64>" }
```

**Un seul message par tick** (250 ms), contenant les updates fusionnés de tous les
rédacteurs. **Aucun champ `author`** : il est impossible en diffusion fusionnée.

Un client qui reçoit un `seq` supérieur à `lastSeq + 1` détecte un trou
(anormal) et déclenche un rattrapage HTTP `GET /api/documents/{id}/updates?since=`.

⚠️ Ce rattrapage est **plafonné à 2000 entrées** (`MAX_UPDATES_PER_CATCH_UP`) et
la troncature n'est pas signalée. Il faut boucler en déplaçant `since` jusqu'à une
réponse vide. Voir [`docs/api.md`](../api.md) §3.1.

### `ack`

```json
{ "type": "ack", "opIds": ["op_8f14e45f-…"], "seq": 143, "creditRemaining": 7420 }
```

- `opIds` est une **liste** : un `ack` retire **tous** les `opId` qu'il contient
  de la file locale.
- `creditRemaining` est un miroir tenu par le serveur (valable car instance
  unique) : la jauge se met à jour sans appel supplémentaire.
- Un `ack` pour un `opId` déjà traité (renvoi) reprend le `seq` d'origine : le
  client le traite normalement.

### `presence`

```json
{ "type": "presence", "users": [{ "email": "awa@exemple.cm", "name": "Awa" }] }
```

### `awareness`

```json
{ "type": "awareness", "documentId": "doc_ab12", "payload": "<Base64>" }
```

### `error`

```json
{ "type": "error", "code": "CREDIT_EXHAUSTED", "opId": "op_8f14…", "creditRemaining": 0, "blockedUntil": "2026-10-25T00:00:00.000Z" }
```

| `code` | Effet attendu côté client (interface, section 9.5) |
| - | - |
| `CREDIT_EXHAUSTED` | Lecture seule, file vidée, **document reconstruit depuis le serveur**, toast « Vos dernières modifications n'ont pas été enregistrées. » |
| `BLOCKED` | Idem, avec `blockedUntil` pour le bandeau |
| `FORBIDDEN` | Lecture seule, « Vous n'avez plus accès à ce document. » |
| `PAYLOAD_TOO_LARGE` | **L'écriture reste possible** ; toast « Cette modification est trop volumineuse et n'a pas été enregistrée. » |
| `INVALID_UPDATE` | Update illisible : abandonné |
| `INVALID_OP_ID` | Bug client : `opId` absent ou trop long |

Un refus **n'est jamais un 500** et ne coupe pas la connexion : la lecture et la
présence restent actives.

## Cycle de vie

```
POST /api/ws-ticket → ws://…/ws?ticket=… → joined
      → update/ack (boucle, un message de diffusion par tick)
      → close → reconnexion : nouveau ticket, rejoin avec le dernier seq
```

- Sans `ack` sous 10 s : renvoi du **même** `opId`, délais 1 / 2 / 4 / 8 s puis
  8 s en boucle, avec ±25 % de variation.
- À la reconnexion : `pendingOps` rejouées dans l'ordre, puis `join`.
- Le repli HTTP utilise `POST /api/documents/{id}/updates` et
  `GET /api/documents/{id}/updates?since=` : mêmes règles de crédit, même
  transaction, donc même garantie C2.
