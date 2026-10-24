# Spécification des messages WebSocket

## Connexion

```
wss://{apiId}.execute-api.eu-west-3.amazonaws.com/prod?ticket={ticket}
```

1. Le client obtient un ticket par `POST /ws-ticket` (JWT en en-tête `Authorization`).
2. Le ticket vaut **60 secondes** et n'est utilisable **qu'une seule fois**.
3. `$connect` consomme le ticket, vérifie l'appartenance au document et enregistre la
   connexion. Si le ticket est invalide, la poignée de main échoue (401).

Le navigateur ne permet pas d'en-têtes personnalisés pendant le handshake : c'est la
raison d'être du ticket, qui évite d'exposer un JWT durable dans les journaux.

## Format

- **JSON uniquement.** Les trames binaires provoquent la fermeture immédiate (code 1003).
- Les updates Yjs sont encodés en **Base64**, plafonnés à **16 Ko de binaire**
  (Base64 ≈ 21,3 Ko, sous la limite de 32 Ko par trame).
- La route est `$default` : le champ `type` sélectionne le comportement.

## Messages client → serveur

### `update`

```json
{ "type": "update", "opId": "op_9f2c…", "payload": "<update Yjs en Base64>" }
```

| Champ | Type | Contrainte | Rôle |
| - | - | - | - |
| `opId` | string | 1–100 caractères | Identifiant d'opération **stable** : un retry réutilise le même |
| `payload` | string | ≤ 16 Ko de binaire | Update Yjs encodé en Base64 |

`opId` est la clé de l'idempotence : un renvoi avec le même `opId` et le même contenu
renvoie l'`ack` d'origine **sans débiter** le crédit. Un même `opId` avec un contenu
différent est rejeté (`OP_ID_CONFLICT`).

> En pratique, le client regroupe les frappes (`BATCH_MS = 300` ms) avec `Y.mergeUpdates`
> avant l'envoi. Le premier update d'un lot ne peut donc pas être acquitté isolément : le
> serveur renvoie l'`ack` du lot entier.

### `awareness`

```json
{ "type": "awareness", "cursor": 128 }
```

Présence et position du curseur. **Non persisté**, **non facturé**, jamais bloquant.

### `ping`

```json
{ "type": "ping" }
```

Maintien de connexion. Réponse : `{"type":"pong","at":1700000000000}`.

## Messages serveur → client

### `joined`

Envoyé une fois après `$connect`.

```json
{
  "type": "joined",
  "connectionId": "abc=",
  "documentId": "doc_ab12",
  "title": "Journal 2026",
  "seq": 142,
  "you": { "email": "awa@exemple.cm", "name": "Awa", "color": "#2563eb" }
}
```

### `ack`

```json
{ "type": "ack", "opId": "op_9f2c", "seq": 143, "duplicate": false, "chars": 12 }
```

`chars` est le nombre de caractères **facturés** (insertions + suppressions). Le client
s'en sert pour rafraîchir l'affichage du crédit ; il n'a aucune valeur d'autorité.

### `update`

Diffusion d'un update accepté à toutes les autres connexions du document.

```json
{
  "type": "update",
  "documentId": "doc_ab12",
  "seq": 143,
  "opId": "op_9f2c",
  "author": "awa@exemple.cm",
  "authorName": "Awa",
  "payload": "<update Yjs en Base64>"
}
```

Un client qui reçoit un `seq` supérieur à son `lastSeq + 1` détecte un trou (anormal) et
déclenche un rattrapage HTTP `GET /documents/{id}/updates?since=`.

### `presence`

```json
{
  "type": "presence",
  "people": [
    { "email": "awa@exemple.cm", "name": "Awa", "color": "#2563eb", "cursor": 128 }
  ]
}
```

### `awareness`

```json
{ "type": "awareness", "email": "awa@exemple.cm", "name": "Awa", "color": "#2563eb", "cursor": 131 }
```

### `error`

```json
{ "type": "error", "code": "CREDIT_EXHAUSTED", "message": "…", "opId": "op_9f2c" }
```

| `code` | Effet attendu côté client |
| - | - |
| `CREDIT_EXHAUSTED` | Passer en **lecture seule**, vider la file locale, **cesser d'envoyer** (sinon 4 refus = auto-blocage) |
| `BLOCKED` | Lecture seule jusqu'à `blockedUntil` (minuit UTC) |
| `PAYLOAD_TOO_LARGE` | Abandonner l'update (il serait rejeté indéfiniment) |
| `OP_ID_CONFLICT` | Le même `opId` a servi pour un autre contenu : bug client, ne pas réessayer |
| `INVALID_UPDATE` | Update illisible : abandonner |
| `WRITE_CONTENTION` | Réeessayer avec le **même** `opId` après un délai |

Aucun code d'erreur ne coupe la connexion : la lecture reste toujours possible.

## Cycle de vie et résilience

```
ticket (60 s) → $connect → joined → update/ack (boucle) → $disconnect
                     ↘ reconnexion : nouveau ticket, reprise à sinceSeq
```

- Connexion morte côté serveur : `postToConnection` renvoie `410 Gone`, la connexion est
  supprimée et la présence rediffusée.
- `Connections` porte un `TTL` de 12 h : les connexions orphelines disparaissent seules.
- Repli HTTP automatique : si le WebSocket ne s'ouvre pas, les **mêmes** updates passent
  par `POST /documents/{id}/updates`. La convergence (C2) est conservée.
