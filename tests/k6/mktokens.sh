#!/bin/bash
# Crée N jetons de charge, sur N adresses distinctes.
#
# Pourquoi plusieurs jetons : le crédit est de 10 000 caractères par jour et par
# **e-mail**. Avec un seul jeton, tous les VUs partagent ce quota ; à
# 300 rédacteurs envoyant 2 updates de 1 caractère par seconde, il est épuisé en
# ~17 secondes et le test mesure le blocage de crédit, pas la convergence.
#
# Le plan v7 parle de « 300 rédacteurs » : ce sont 300 personnes, donc 300
# comptes. Ce script reproduit cette condition.
#
# Usage :
#   ./mktokens.sh [nombre] [fichier_de_sortie]
#   ./mktokens.sh 4 /home/ec2-user/tokens.txt
#
# Le fichier contient une ligne « email:token » par compte ; le lanceur en
# extrait la liste des jetons séparés par des virgules.
set -uo pipefail

COUNT="${1:-4}"
OUT="${2:-/home/ec2-user/tokens.txt}"
API_URL="${API_URL:-http://13.53.160.209}"
RUN="$(date +%s)"

: > "$OUT"

for index in $(seq 1 "$COUNT"); do
  EMAIL="charge${index}-${RUN}@exemple.cm"
  payload="{\"name\":\"Charge ${index}\",\"email\":\"${EMAIL}\"}"

  TOKEN="$(curl -s -X POST "${API_URL}/api/session" \
    -H 'content-type: application/json' \
    -d "${payload}" \
    | python3 -c 'import json,sys; print(json.load(sys.stdin).get("token",""))')"

  if [ -z "$TOKEN" ]; then
    echo "ECHEC : aucun jeton pour ${EMAIL}" >&2
    exit 1
  fi

  printf '%s:%s\n' "$EMAIL" "$TOKEN" >> "$OUT"
  echo "  ${index}/${COUNT}  ${EMAIL}"
done

echo
echo "${COUNT} jetons ecrits dans ${OUT}"
echo
echo "Liste a passer a k6 (separer par des virgules) :"
echo "  TOKENS=$(cut -d: -f2 "$OUT" | paste -sd, -)"
