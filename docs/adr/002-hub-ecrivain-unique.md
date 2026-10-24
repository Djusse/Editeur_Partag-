# ADR 002 — Hub temps réel : écrivain unique, tick de 250 ms, transaction atomique

**Statut :** accepté · **Date :** 2026-10-24

## Contexte

C2 exige qu'aucune modification acceptée ne soit perdue et que tous les
participants convergent. C4 exige qu'aucun rédacteur ne dépasse son crédit.
Les deux se jouent au même instant : l'écriture d'un update.

À 300 rédacteurs dans un document, avec 1 update/s chacun, le fan-out naïf
(1 message par client et par update) produirait **90 000 envois par seconde** :
impossible.

## Décision

**Une boucle d'écriture par document** (`DocumentState`) :

1. Le client regroupe ses frappes (`BATCH_MS` = 300 ms) en **un** update et
   l'envoie avec un `opId` stable.
2. Le serveur valide et **met en file** (pas d'écriture immédiate).
3. Un **tick de 250 ms** vide la file et écrit **un lot** dans une seule
   transaction DynamoDB :
   - `Documents` : `SET seq = :next`, condition `seq = :current` ;
   - `Updates` : Put du journal (updates fusionnés par `Y.mergeUpdates`) ;
   - `Credits` : **un élément par expéditeur**, `ADD used :chars` ;
   - `OpIds[OP#]` et `OpIds[HASH#]` : un marqueur par update et par contenu.
4. Après succès : l'update fusionné est appliqué au `Y.Doc` en mémoire, **un seul
   message** est diffusé à tous, et **un `ack` par expéditeur** liste ses `opIds`.

## Justification

- **Séquence sans contention** : un seul écrivain, donc aucun retry de conflit à
  prévoir. La condition `seq = :current` reste une **garde** contre un second
  processus (redémarrage, erreur de déploiement), pas une source de latence.
- **Atomicité** : la transaction garantit qu'il n'existe ni trou de `seq`, ni
  crédit débité pour un update non écrit, ni marqueur sans update. C'est ce qui
  rend C2 et C4 **structurellement** vrais.
- **Acquittement après durabilité** : un `ack` ne part qu'après le commit. Un
  client qui perd la réponse renvoie le même `opId`, reconnu par `OpIds` : pas de
  double débit, pas de doublon dans le journal.
- **Fan-out borné** : 4 messages/s au lieu de 300. Le coût ne dépend plus du
  nombre de rédacteurs.
- **Un refus n'empoisonne pas le lot** : si un expéditeur dépasse son crédit, la
  transaction est annulée, les `CancellationReasons` désignent **son** élément
  `Credits`, il est retiré du lot et les autres sont réécrits immédiatement.

## Alternatives écartées

| Alternative | Raison du rejet |
| - | - |
| Écriture par update (une transaction par frappe) | 300 transactions/s sur la même clé = throttling et latence |
| File SQS FIFO par document | Déplace le problème vers la latence et complexifie l'`ack` ; inutile avec un écrivain unique |
| Diffusion par update sans regroupement | Quadratique, cf. 90 000 envois/s |
| Écriture optimiste sans transaction | Trous de `seq` et crédit débité à tort |

## Conséquences

- La latence perçue d'une écriture est **au plus** `BATCH_MS + tick` ≈ 550 ms,
  sous l'objectif de 1 s.
- Un lot volumineux peut dépasser les limites DynamoDB : la taille du lot est
  bornée par le nombre d'expéditeurs du tick, et le plafond de 64 Ko s'applique
  par update.
- Le snapshot S3 est pris automatiquement (50 entrées ou 2 minutes), ce qui borne
  la taille du rattrapage et sert de base au PDF.
