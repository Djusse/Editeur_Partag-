#!/bin/bash
# Crée un jeton de rédacteur pour les tests de charge, et l'enregistre dans
# /home/ec2-user/token.txt.
#
# Pourquoi un fichier plutôt qu'une commande en ligne : l'appel SSM transporte
# la commande dans du JSON, et l'imbrication des guillemets de `curl -d "{...}"`
# casse le parsing. Un script déposé une fois (en base64) évite le problème.
#
# Usage :
#   API_URL est lu dans l'environnement, ou vaut l'IP de production.
#   ./mktoken.sh [email]
set -uo pipefail

API_URL="${API_URL:-http://13.53.160.209}"
EMAIL="${1:-charge-$(date +%s)@exemple.cm}"
OUT="${OUT:-/home/ec2-user/token.txt}"

payload="{\"name\":\"Charge\",\"email\":\"${EMAIL}\"}"

TOKEN="$(curl -s -X POST "${API_URL}/api/session" \
  -H 'content-type: application/json' \
  -d "${payload}" \
  | python3 -c 'import json,sys; print(json.load(sys.stdin).get("token",""))')"

if [ -z "$TOKEN" ]; then
  echo "ECHEC : aucun jeton recu de ${API_URL}/api/session" >&2
  exit 1
fi

printf '%s\n' "$TOKEN" > "$OUT"
echo "jeton enregistre pour ${EMAIL} dans ${OUT} (${#TOKEN} caracteres)"
