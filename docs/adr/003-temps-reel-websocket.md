# ADR 003 — Temps réel : API Gateway WebSocket + repli HTTP

**Statut :** accepté · **Date :** 2026-10-24

## Contexte

Les rédacteurs doivent voir les modifications des autres « presque aussitôt » (cible
p95 < 1 s) et savoir qui est présent. Le serveur ne peut pas garder d'état en mémoire
(Lambda), et API Gateway WebSocket **refuse les trames binaires** (fermeture 1003) avec
une trame plafonnée à 32 Ko et un message à 128 Ko.

## Décision

1. **Transport** : API Gateway WebSocket, routes `$connect`, `$disconnect`, `$default`
   (dispatch sur `body.type` : `update`, `awareness`, `ping`).
2. **Encodage** : **JSON uniquement**, l'update Yjs en **Base64**, plafonné à **16 Ko de
   binaire** côté client et côté serveur (Base64 +33 %).
3. **Authentification** : ticket à usage unique (60 s) via `POST /ws-ticket`, passé en
   query string. Le navigateur interdit les en-têtes personnalisés au handshake.
4. **Fan-out groupé** : diffusion par lots de 25 connexions, avec suppression des
   connexions mortes (`410 Gone`).
5. **Regroupement client** : `BATCH_MS = 300` ms. Les frappes sont fusionnées via
   `Y.mergeUpdates` en un seul update.
6. **Repli HTTP** : si le WebSocket ne s'ouvre pas, les **mêmes** updates passent par
   `POST /documents/{id}/updates`, et le rattrapage par `GET …?since=seq` toutes les 1,5 s.

## Justification

- **Aucune perte (C2)** : chaque update est acquitté avec un `seq`; un update non acquitté
  est renvoyé avec le **même `opId`** et reconnu par le marqueur d'idempotence.
- **Coût maîtrisé** : sans regroupement, 300 rédacteurs à 1 update/s produiraient
  ~90 000 appels `postToConnection` par seconde (quadratique). Avec 300 ms de
  regroupement, on tombe à ~1 000 appels/s au pire.
- **Repli HTTP** : garantit la conformité à C2 même si le WebSocket est indisponible. Il
  conserve Yjs, donc la convergence — contrairement à une sauvegarde/polling qui écraserait
  le texte.
- **Ticket jetable** : évite d'exposer un JWT durable dans les journaux d'accès.

## Alternatives écartées

| Alternative | Raison du rejet |
| - | - |
| y-websocket sur EC2 | État en mémoire, un seul point de défaillance, pas de mise à l'échelle |
| Binômé sur API Gateway WebSocket | Fermeture 1003 : le service refuse les trames binaires |
| JWT directement en query string | Réutilisable s'il fuit dans les logs |
| Polling seul | Latence de 1,5 s et charge d'API inutile en régime normal |

## Conséquences

- La présence (`awareness`) n'est **pas** persistée : elle est perdue à la déconnexion,
  ce qui est le comportement attendu.
- Le rattrapage à la reconnexion repose sur `GET …?since=seq`, borné à 1 000 updates par
  appel ; au-delà, le client reprend l'état complet.
- Un document dont le journal dépasse le seuil (`SNAPSHOT_INTERVAL`) est compacté en
  snapshot S3, ce qui borne la taille du rattrapage.
