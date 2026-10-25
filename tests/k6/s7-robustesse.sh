#!/usr/bin/env bash
# S7 — robustesse : que se passe-t-il si le serveur est tué pendant l'écriture ?
#
# Objectif du plan v7 : `kill -9` du processus pendant S2 (palier 50). Après
# redémarrage par systemd, tous les updates **acquittés** sont présents, les non
# acquittés sont renvoyés par les clients avec le même `opId`, et aucun n'est
# débité deux fois.
#
# Ce scénario ne peut pas être un simple script k6 : il faut agir sur l'instance
# (tuer le processus) pendant qu'un client écrit. L'orchestration est donc ici,
# et k6 fournit la charge.
#
# Prérequis :
#   - AWS CLI configuré, droits ssm:SendCommand sur l'instance ;
#   - k6 installé ;
#   - un jeton de rédacteur et un document.
#
# Usage :
#   TOKEN=<jwt> DOC_ID=<doc> INSTANCE=i-047242beb2de758e5 \
#   API_URL=http://13.53.160.209 ./tests/k6/s7-robustesse.sh
set -uo pipefail

# Pas d'apostrophe dans les messages `${VAR:?…}` : dans un guillemet double,
# une apostrophe ferme la citation et casse le parsing (`d'un rédacteur`).
API_URL="${API_URL:?API_URL requis, ex. http://13.53.160.209}"
TOKEN="${TOKEN:?TOKEN requis, JWT de redacteur}"
DOC_ID="${DOC_ID:?DOC_ID requis}"
INSTANCE="${INSTANCE:?INSTANCE requis, identifiant EC2}"
AWS_REGION="${AWS_REGION:-eu-north-1}"
WRITERS="${WRITERS:-50}"
DURATION="${DURATION:-20s}"
KILL_AFTER="${KILL_AFTER:-8}"

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"
mkdir -p tests/results

say() { printf '\n=== %s ===\n' "$1"; }

# `seq` courant, lu sur l'API d'état.
#
# On extrait le champ avec Python plutôt qu'avec `sed` : la classe de caractères
# `[[:space:]]` combinée aux parenthèses de capture déclenchait une erreur de
# parsing dans le shell. Python est déjà requis plus bas.
current_seq() {
  curl -s "$API_URL/api/documents/$DOC_ID/state" -H "authorization: Bearer $TOKEN" \
    | python3 -c 'import json,sys; print(json.load(sys.stdin).get("seq", ""))'
}

# Nombre d'updates acquittés, lu dans le résumé k6 (JSON).
acked_count() {
  python3 - "$1" <<'PY'
import json
import sys

path = sys.argv[1]
try:
    with open(path) as handle:
        data = json.load(handle)
    print(int(data["metrics"]["s2_acked"]["values"]["count"]))
except Exception:
    print(-1)
PY
}

# --- 1. État avant -----------------------------------------------------------
say "1/5 État avant le test"
SEQ_BEFORE="$(current_seq)"
echo "seq avant : ${SEQ_BEFORE:-inconnu}"
if [[ -z "$SEQ_BEFORE" ]]; then
  echo "ERREUR : impossible de lire le seq (jeton ou document invalide ?)."
  exit 1
fi

# --- 2. Charge en arrière-plan ----------------------------------------------
say "2/5 Démarrage de $WRITERS rédacteurs pendant $DURATION"
k6 run -q \
  -e API_URL="$API_URL" -e TOKEN="$TOKEN" -e DOC_ID="$DOC_ID" \
  -e WRITERS="$WRITERS" -e DURATION="$DURATION" \
  --summary-export=tests/results/s7-charge.json \
  tests/k6/s2-convergence.js > tests/results/s7-charge.log 2>&1 &
K6_PID=$!
echo "k6 lancé (pid $K6_PID)"

# --- 3. Tue le serveur en pleine écriture -----------------------------------
say "3/5 kill -9 du processus applicatif dans ${KILL_AFTER}s"
sleep "$KILL_AFTER"

CMD_ID="$(aws ssm send-command \
  --instance-ids "$INSTANCE" \
  --region "$AWS_REGION" \
  --document-name AWS-RunShellScript \
  --comment "S7 kill -9" \
  --parameters 'commands=["sudo systemctl kill -s KILL editeur-app || true","sleep 1","systemctl is-active editeur-app || true"]' \
  --query "Command.CommandId" --output text)"
echo "commande SSM : $CMD_ID"

sleep 5
aws ssm get-command-invocation --command-id "$CMD_ID" --instance-id "$INSTANCE" \
  --region "$AWS_REGION" --query "[Status,StandardOutputContent]" --output text || true

# --- 4. Attend le redémarrage automatique (systemd Restart=always) ----------
say "4/5 Attente du redémarrage applicatif"
HEALTHY=0
for _ in $(seq 1 40); do
  if curl -fsS "$API_URL/health" >/dev/null 2>&1; then
    echo "  /health répond de nouveau"
    HEALTHY=1
    break
  fi
  printf '.'
  sleep 2
done
echo

if [[ "$HEALTHY" -ne 1 ]]; then
  echo "ERREUR : l'application n'est pas revenue. Restart=always devrait la relancer."
  exit 1
fi

wait "$K6_PID" 2>/dev/null || true

# --- 5. Vérifications -------------------------------------------------------
say "5/5 Bilan"

SEQ_AFTER="$(current_seq)"
echo "seq après  : ${SEQ_AFTER:-inconnu}"
echo "progression: $(( ${SEQ_AFTER:-0} - SEQ_BEFORE )) entrées de journal"

ACKS="$(acked_count tests/results/s7-charge.json)"
echo "updates acquittés (k6) : $ACKS"

# Contiguïté du journal : la signature d'une écriture perdue serait un trou.
python3 - "$API_URL" "$DOC_ID" "$TOKEN" "$SEQ_BEFORE" <<'PY'
import json
import sys
import urllib.request

api, doc, token, since = sys.argv[1], sys.argv[2], sys.argv[3], int(sys.argv[4])
request = urllib.request.Request(
    f"{api}/api/documents/{doc}/updates?since={since}",
    headers={"authorization": f"Bearer {token}"},
)
with urllib.request.urlopen(request) as response:
    rows = json.load(response)["updates"]

seqs = [row["seq"] for row in rows]
if not seqs:
    print("journal : aucune entrée depuis le début du test")
    sys.exit(0)

expected = set(range(seqs[0], seqs[-1] + 1))
missing = sorted(expected - set(seqs))
print(f"journal : {len(seqs)} entrées, de {seqs[0]} à {seqs[-1]}")
print("journal : AUCUN trou" if not missing else f"journal : TROUS {missing}")
PY

say "Résultat"
if [[ "${SEQ_AFTER:-0}" -gt "$SEQ_BEFORE" ]]; then
  echo "OK   : le journal a progressé malgré le kill -9 ($SEQ_BEFORE -> $SEQ_AFTER)."
else
  echo "ECHEC : aucune progression du journal après le redémarrage."
  exit 1
fi

if [[ "$ACKS" -lt 0 ]]; then
  echo "AVERTISSEMENT : résumé k6 illisible, voir tests/results/s7-charge.log"
fi

echo
echo "Pour conclure S7, vérifier en plus :"
echo "  - les 'ack' reçus avant le kill se retrouvent tous dans le journal"
echo "    ($ACKS acquittés pour $(( ${SEQ_AFTER:-0} - SEQ_BEFORE )) groupes écrits :"
echo "     un groupe fusionne plusieurs updates par tick de 250 ms)"
echo "  - aucun doublon débité : le crédit consommé ne dépasse pas les caractères émis"
echo "  - aucune perte côté client : recharger la page et vérifier le texte"
echo "  - journal applicatif : sudo tail -50 /var/log/editeur/app.log"
