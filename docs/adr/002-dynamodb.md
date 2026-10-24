# ADR 002 — DynamoDB à la demande

**Statut :** accepté · **Date :** 2026-10-24

## Contexte

Deux contraintes éliminatoires reposent sur des **écritures concurrentes** :

- C1 : un compteur de téléchargements qui ne doit **jamais** dépasser N ;
- C4 : un compteur de crédit partagé entre tous les appareils d'un rédacteur.

Dans les deux cas, une séquence « lire puis écrire » classique est incorrecte : deux
requêtes simultanées liraient la même valeur et écriraient la même valeur décrémentée.

## Décision

DynamoDB en **mode à la demande** (`PAY_PER_REQUEST`), avec des écritures
**conditionnelles et atomiques** :

- claim : `TransactWriteItems` qui décrémente `remaining` sous condition `remaining > 0`
  **et** crée le ticket sous condition `attribute_not_exists(visitorId)` ;
- écriture : une transaction de **5 éléments** (séquence du document, update, crédit,
  marqueur `opId`, marqueur de contenu) avec conditions sur chacun.

## Justification

- **Condition atomique** : la condition est évaluée par le service au moment de
  l'écriture. Aucune fenêtre de course n'existe, contrairement à un `SELECT … FOR UPDATE`
  applicatif mal placé.
- **Transaction multi-éléments** : elle garantit qu'il ne peut pas exister de trou dans
  les `seq`, ni de crédit débité pour un update non persisté. C'est ce qui rend C2 et C4
  **structurellement** vrais, et pas seulement probables.
- **`CancellationReasons`** : la transaction renvoie la raison précise de l'échec
  (`ConditionalCheckFailed` sur le crédit, sur l'`opId`, sur le `seq`), ce qui permet une
  réponse métier exacte au lieu d'un 500.
- **Mode à la demande** : pas de capacité à provisionner pour un pic d'une minute ; le
  coût suit strictement l'usage.
- **TTL natif** : tickets, marqueurs d'idempotence, crédits et connexions expirent seuls.

## Alternatives écartées

| Alternative | Raison du rejet |
| - | - |
| RDS PostgreSQL + `FOR UPDATE` | Pas dans le plan gratuit durable, verrous lourds sous 200 req/s sur une même ligne |
| Compteur en mémoire (Lambda) | Non partagé entre conteneurs : C1 et C4 cassés |
| Verrou distribué maison (S3/SSM) | Latence et complexité ; le service fournit la primitive |

## Conséquences

- **Clé chaude** : le compteur `seq` d'un document est sérialisé par document. C'est
  assumé (voir ADR 007 pour la montée en charge) et mesuré en S2.
- **Limite de 100 actions par transaction** : à respecter si `commitBatch` est introduit.
- Les scans de supervision (`/admin/state`) sont bornés et non utilisés dans le chemin
  critique.
