# Scénarios de charge (k6)

Les six contraintes du sujet sont évaluées **par la mesure**. Ces scripts
produisent ces mesures.

## Préparation de la machine de charge

Le test doit tourner **dans la même région AWS que l'instance** : depuis un poste
local, on mesurerait le réseau, pas l'application.

```bash
sudo ./tests/k6/install-k6.sh
k6 version
```

`install-k6.sh` récupère le **binaire officiel** de la dernière version, et non
le paquet RPM : le dépôt `dl.k6.io/rpm` n'a pas toujours de paquet pour Amazon
Linux 2023 (échec constaté). Le script échoue bruyamment si un étape casse —
une installation silencieusement ratée coûte plus cher qu'une installation
visible (`k6: command not found` au moment du test).

`k6` n'a besoin d'aucune dépendance Node : les scripts sont autonomes.

### Le seul module WebSocket qui fonctionne partout

Les scénarios S2 et S5 ouvrent de vraies connexions WebSocket, via
[`lib/ws.js`](lib/ws.js), qui importe **`k6/ws`**.

Ce choix n'est pas cosmétique. Vérifié au banc sur k6 v0.54.0 :

| Module | v0.54.0 | Remarque |
| - | - | - |
| `WebSocket` global | ❌ | `ReferenceError: WebSocket is not defined` |
| `k6/experimental/websocket` | ❌ | `unknown module` |
| `k6/websocket` | ❌ | `unknown module` (n'existe qu'à partir de k6 v1.0) |
| `k6/ws` | ✅ | présent depuis la 0.41, API inchangée |

Autrement dit : toute autre choix casse le test sur une partie des versions
installables. `lib/ws.js` documente aussi les différences d'API (`ws.connect`,
`socket.on('message')`, `socket.setTimeout`) qui expliquent sa forme.

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
       -e WRITERS=100 -e DURATION=60s -e PACE_MS=1000 \
       tests/k6/s2-convergence.js
```

Paliers : `WRITERS=50`, puis `100`, puis `300`. Le palier retenu est le plus
haut où `s2_missing_ack` reste à 0.

### Connexion persistante et cadence

Chaque VU ouvre **une** connexion WebSocket et écrit toutes les `PACE_MS`
pendant `DURATION` — c'est le profil d'un rédacteur réel.

Une version antérieure ouvrait une connexion par update. Au banc, chaque VU
bouclait alors ~110 itérations par seconde, soit 220 caractères/s : le quota de
10 000 caractères partait en 45 s et le test mesurait le **blocage de crédit**
au lieu de la convergence. Ouvrir et fermer une connexion par update teste en
outre la poignée de main, pas le hub.

### Budget de crédit à vérifier avant chaque tir

Crédit : 10 000 caractères par jour et **par e-mail**. Avec `T` jetons,
`ceil(WRITERS / T)` VUs partagent chaque quota, d'où

```
budget par compte = ceil(WRITERS / T) × (DURATION / PACE_MS)
```

S2 affiche ce budget au démarrage et prévient s'il dépasse 10 000. Repères :

| WRITERS | jetons | DURATION | PACE_MS | budget/compte |
| - | - | - | - | - |
| 50 | 1 | 45 s | 1000 | 50 |
| 100 | 1 | 60 s | 1000 | 60 |
| 300 | 4 | 60 s | 1000 | 75 |

Un budget dépassé ne casse pas C2 : les VUs sont arrêtés par un refus explicite
et le verdict affiche **« MESURE INVALIDÉE PAR LE CRÉDIT »**. C'est volontaire —
un palier interrompu ne prouve rien, et le taire serait pire.

Le crédit est de 10 000 caractères **par e-mail** : à plus d'un jeton, répartir
les VUs avec `-e TOKEN=j1,j2,j3`. Les comptes doivent être **membres** du
document, sinon `POST /ws-ticket` répond 403 — `mktokens.sh` fait les deux :

```bash
./tests/k6/mktokens.sh 4 /home/ec2-user/tokens.txt "$DOC_ID" "$OWNER_TOKEN"
```

**k6 mesure le débit d'acquittement.** La contiguïté du journal et la
convergence du **contenu** se vérifient ensuite avec un vrai client Yjs :

```bash
node tests/node/verify-convergence.mjs \
  --api=http://13.53.160.209/api --token=$TOKEN --doc=$DOC_ID
```

Le `--api` inclut le préfixe `/api`. Le script reconstruit le document depuis
`/state` puis le journal paginé de `/updates`, contrôle la contiguïté des `seq`,
et compare deux reconstructions indépendantes (empreinte SHA-256). Verdict
attendu : `CONVERGENCE OK`, code de sortie 0.

## S5 — C5 : pic complet (visiteurs + rédacteurs)

```bash
k6 run -e API_URL=http://13.53.160.209 \
       -e TOKEN=$TOKEN \
       -e DOC_ID=$DOC_ID \
       -e VISITORS=15000 -e MAX_DOWNLOADS=500 -e WRITERS=300 \
       -e WRITER_DURATION=120s -e PACE_MS=2000 \
       tests/k6/s5-mixte.js
```

Essai à blanc avant le tir réel — mêmes scénarios, ~17 s au lieu de 115 s :

```bash
k6 run -e API_URL=http://13.53.160.209 -e TOKEN=$TOKEN -e DOC_ID=$DOC_ID \
       -e VISITORS=200 -e MAX_DOWNLOADS=10 -e WRITERS=4 \
       -e WRITER_DURATION=10s -e PACE_MS=1000 -e RAMP_SCALE=0.15 \
       tests/k6/s5-mixte.js
```

Le verdict de S5 vient de `handleSummary`, qui seul reçoit les métriques
agrégées de tous les VUs. Un `✗` en fin de scénario n'est pas un échec de test :
k6 renvoie le code 99 quand un seuil casse, et les scripts énumèrent eux-mêmes
les seuils en échec (`SEUIL EN ÉCHEC : …`).

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
  Le quota d'un lien réutilisé est inconnu (`/status` ne publie que `remaining`),
  donc le verdict S5 n'affiche pas de comparaison à `MAX_DOWNLOADS` : il
  indiquerait « 500 sur 100 », ce qui serait faux.
- **La garde mémoire** renvoie `202 waiting` plutôt que d'écraser DynamoDB :
  c'est normal et attendu. Ne le comptez pas comme un échec.
- **Ne pas mettre de seuil sur `http_req_failed` dans le scénario visiteur.**
  k6 compte tout statut ≥ 400 comme échec, or 410 « épuisé » est une réponse
  **normale** du parcours visiteur. Un tel seuil est inatteignable par
  construction (mesuré : 84 % de « requêtes échouées » sans la moindre panne).
  Le critère « aucun 5xx » est porté par le compteur `s5_visitor_errors`.
- **Un `✗` en fin de scénario n'est pas forcément un échec de test.** k6 renvoie
  le code 99 quand un seuil casse : c'est ce code, et non la croix, qui fait foi.
  Les scripts énumèrent eux-mêmes les seuils en échec (`SEUIL EN ÉCHEC : …`),
  car renvoyer `stdout` depuis `handleSummary` supprime le tableau de k6.
- **Essai à blanc avant le tir réel.** `-e RAMP_SCALE=0.15` compresse les
  paliers de S5 de 115 s à ~17 s, sans changer la forme de la charge. Cela
  évite les deux minutes perdues par essai — et la tentation de ne pas tester.
