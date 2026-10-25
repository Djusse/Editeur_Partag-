# Scénarios de charge (k6)

Les six contraintes du sujet sont évaluées **par la mesure**. Ces scripts
produisent ces mesures.

## Préparation de la machine de charge

Le test doit tourner **dans la même région AWS que l'instance** : depuis un poste
local, on mesurerait le réseau, pas l'application.

```bash
# Sur une EC2 dédiée (t3.small suffit pour la charge elle-même)
sudo dnf install -y dnf-plugins-core
sudo dnf config-manager --add-repo https://dl.k6.io/rpm/repo.repo
sudo dnf install -y k6

k6 version    # ≥ 0.49
```

`k6` n'a besoin d'aucune dépendance Node : les scripts sont autonomes.

## Récupérer un jeton

Toutes les routes du rédacteur exigent un JWT :

```bash
curl -s -X POST http://13.53.160.209/api/session \
  -H 'content-type: application/json' \
  -d '{"name":"Charge","email":"charge-s1@exemple.cm"}' \
  | python3 -c 'import json,sys; print(json.load(sys.stdin)["token"])'
```

> ⚠️ **Un compte par scénario.** Le crédit est de 10 000 caractères par jour et
> par e-mail, et il est **débité par la préparation** (écriture du document
> initial). Utiliser le compte de démonstration pour les tests de charge le
> condamnerait pour la soutenance.

## S1 — C1 : quota exact sous pic

15 000 visiteurs, 500 exemplaires, 80 % du pic en 60 s.

```bash
k6 run -e API_URL=http://13.53.160.209 \
       -e TOKEN=$TOKEN \
       -e MAX_DOWNLOADS=500 \
       -e VISITORS=15000 \
       --summary-export=tests/results/s1.json \
       tests/k6/s1-claim.js
```

**Critère de réussite** : `s1_reserved` = 500 exactement, `remaining` final = 0,
statut `exhausted`, aucun 5xx.

Mise au point rapide (30 s) :

```bash
k6 run -e API_URL=http://13.53.160.209 -e TOKEN=$TOKEN \
       -e MAX_DOWNLOADS=10 -e VISITORS=200 tests/k6/s1-claim.js
```

## S2 — C2 : convergence avec N rédacteurs

Le document doit **exister avant** le test :

```bash
DOC_ID=$(curl -s -X POST http://13.53.160.209/api/documents \
  -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d '{"title":"Charge S2"}' | python3 -c 'import json,sys; print(json.load(sys.stdin)["id"])')

k6 run -e API_URL=http://13.53.160.209 -e TOKEN=$TOKEN -e DOC_ID=$DOC_ID \
       -e WRITERS=100 -e DURATION=60s \
       --summary-export=tests/results/s2-100.json \
       tests/k6/s2-convergence.js
```

Paliers : `WRITERS=50`, puis `100`, puis `300`. Le palier retenu est le plus
haut où `s2_missing_ack` reste à 0.

**k6 mesure le débit d'acquittement et la contiguïté du `seq`.** La convergence
du **contenu** se vérifie ensuite avec un client Yjs :

```bash
node tests/node/verify-convergence.mjs \
  --api=http://13.53.160.209 --token=$TOKEN --doc=$DOC_ID
```

## S5 — C5 : pic complet (visiteurs + rédacteurs)

```bash
k6 run -e API_URL=http://13.53.160.209 \
       -e TOKEN=$TOKEN -e TOKEN2=$TOKEN2 \
       -e DOC_ID=$DOC_ID \
       -e VISITORS=15000 -e MAX_DOWNLOADS=500 -e WRITERS=300 \
       --summary-export=tests/results/s5.json \
       tests/k6/s5-mixte.js
```

Pendant l'exécution, relever le CPU et la mémoire de l'instance :

```bash
INSTANCE=i-047242beb2de758e5
START=$(date -u -d '5 minutes ago' +%Y-%m-%dT%H:%M:%SZ)
END=$(date -u +%Y-%m-%dT%H:%M:%SZ)

aws cloudwatch get-metric-statistics --namespace AWS/EC2 \
  --metric-name CPUUtilization \
  --dimensions Name=InstanceId,Value=$INSTANCE \
  --start-time $START --end-time $END --period 60 \
  --statistics Maximum Average --region eu-north-1 --output table
```

Pour la mémoire, il faut l'agent CloudWatch ou une lecture par SSM :

```bash
aws ssm send-command --instance-ids $INSTANCE --region eu-north-1 \
  --document-name AWS-RunShellScript \
  --parameters 'commands=["free -m; ps -o rss= -C node | awk \"{s+=\\$1} END {print s/1024\\\" Mio RSS node\\\"}\""]' \
  --query "Command.CommandId" --output text
```

## S7 — robustesse : `kill -9` pendant l'écriture

```bash
TOKEN=$TOKEN DOC_ID=$DOC_ID INSTANCE=i-047242beb2de758e5 \
API_URL=http://13.53.160.209 \
./tests/k6/s7-robustesse.sh
```

Le script lance 50 rédacteurs, tue le processus au bout de 8 s via SSM, attend le
redémarrage par systemd, puis vérifie que le journal a progressé **sans trou**.

**Ce que S7 prouve** : `Restart=always` ramène le service, et la reprise côté
client (même `opId`, déduplication serveur) ne perd ni ne double aucune écriture.

## Scénarios couverts autrement

| Scénario | Contrainte | Script |
| - | - | - |
| S3 — PDF = dernière version | C3 | [`backend/test-link-real.mjs`](../../backend/test-link-real.mjs) |
| S4 — crédit, 5 appareils, blocage | C4 | [`backend/test-credit-exhaustion.mjs`](../../backend/test-credit-exhaustion.mjs) |
| S6 — délai du dernier exemplaire | C6 | [`backend/test-visitor-routes.mjs`](../../backend/test-visitor-routes.mjs) |

Ces trois-là ne nécessitent pas de charge : ils se vérifient avec un script Node
ordinaire, contre l'instance en production (`API_URL=http://13.53.160.209`).

## Ce qui reste à mesurer pour le rapport

| À documenter | Comment |
| - | - |
| Réservations exactes sous pic | `s1_reserved` du résumé JSON |
| Palier de rédacteurs atteint | palier le plus haut avec `s2_missing_ack = 0` |
| Latence `claim` p95/p99 | `s1_claim_latency` |
| Effet du micro-cache | `s5_status_latency` médiane (< 100 ms ⇒ nginx répond) |
| CPU max de l'instance | CloudWatch `CPUUtilization` |
| Mémoire de pointe | RSS du processus node |
| Comportement après `kill -9` | sortie de `s7-robustesse.sh` |

## Pièges

- **Ne pas relancer `deploy.sh` après un test de charge.** L'AMI est résolue à
  chaque déploiement : une nouvelle AMI remplacerait l'instance et changerait
  l'IP, invalidant les mesures.
- **Le crédit limite S2.** Chaque rédacteur consomme des caractères. Avec
  `UPDATE_B64` par défaut, c'est 1 caractère par update ; à 300 rédacteurs ×
  5 updates, cela reste sous 10 000. Un texte plus long épuiserait le quota et
  fausserait le test (les `error` seraient comptés comme des rejets).
- **`LINK_TOKEN` peut être réutilisé** dans S5 pour éviter de recréer un lien :
  `-e LINK_TOKEN=<token>`. Un lien déjà épuisé donnera 100 % d'`exhausted`.
- **La garde mémoire** renvoie `202 waiting` plutôt que d'écraser DynamoDB :
  c'est normal et attendu. Ne le comptez pas comme un échec.
