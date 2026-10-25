#!/bin/bash
# Crée N jetons de charge sur N adresses distinctes, **et les ajoute comme
# rédacteurs du document**.
#
# Deux raisons, apprises à l'usage :
#
#  1. **Crédit.** Il est de 10 000 caractères par jour et par e-mail. Avec un
#     seul jeton, tous les VUs partagent ce quota ; à 300 rédacteurs, il est
#     épuisé en ~17 s et le test mesure le blocage de crédit, pas la
#     convergence.
#
#  2. **Accès.** `POST /api/ws-ticket` vérifie l'appartenance au document via
#     `requireAccess`. Un compte fraîchement créé n'est membre de rien : les
#     2 250 tentatives du premier essai ont toutes été refusées. Chaque compte
#     doit donc être ajouté par le propriétaire du document.
#
# Usage :
#   ./mktokens.sh <nombre> [fichier] <documentId> [tokenProprietaire]
#
# Exemple :
#   ./mktokens.sh 4 /home/ec2-user/tokens.txt doc_abc123 "$OWNER_TOKEN"
#
# Sortie : une ligne « email:token » par compte, puis la liste à passer à k6.
set -uo pipefail

COUNT="${1:-4}"
OUT="${2:-/home/ec2-user/tokens.txt}"
DOC_ID="${3:-}"
OWNER_TOKEN="${4:-}"

API_URL="${API_URL:-http://13.53.160.209}"
RUN="$(date +%s)"

if [ -z "$DOC_ID" ]; then
  echo "ERREUR : l'identifiant du document est requis (3e argument)." >&2
  echo "  ./mktokens.sh 4 /home/ec2-user/tokens.txt doc_abc123 \$OWNER_TOKEN" >&2
  exit 1
fi

if [ -z "$OWNER_TOKEN" ]; then
  echo "ERREUR : le jeton du propriétaire est requis (4e argument)." >&2
  echo "  Sans lui, les comptes créés ne seraient pas membres du document" >&2
  echo "  et /api/ws-ticket les refuserait (403)." >&2
  exit 1
fi

# Vérifie d'abord que le propriétaire a bien accès, sinon le message d'erreur
# serait « 403 sur l'ajout de membre » au lieu de « jeton propriétaire invalide ».
if ! curl -fsS "${API_URL}/api/documents/${DOC_ID}" \
  -H "authorization: Bearer ${OWNER_TOKEN}" >/dev/null 2>&1; then
  echo "ERREUR : le jeton propriétaire n'a pas accès à ${DOC_ID}." >&2
  exit 1
fi

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

  # Ajout comme rédacteur. Un 409 (déjà membre) est acceptable : le compte
  # pourrait exister d'un passage précédent avec la même adresse.
  STATUS="$(curl -s -o /dev/null -w '%{http_code}' -X POST \
    "${API_URL}/api/documents/${DOC_ID}/members" \
    -H "authorization: Bearer ${OWNER_TOKEN}" \
    -H 'content-type: application/json' \
    -d "{\"email\":\"${EMAIL}\"}")"

  case "$STATUS" in
    200|201) RESULTAT="membre ajoute" ;;
    409) RESULTAT="deja membre" ;;
    *)
      echo "ECHEC : ajout de ${EMAIL} refuse (HTTP ${STATUS})" >&2
      exit 1
      ;;
  esac

  printf '%s:%s\n' "$EMAIL" "$TOKEN" >> "$OUT"
  echo "  ${index}/${COUNT}  ${EMAIL}  (${RESULTAT})"
done

echo
echo "${COUNT} jetons ecrits dans ${OUT}"
echo
echo "Liste a passer a k6 :"
echo "  TOKENS=$(cut -d: -f2 "$OUT" | paste -sd, -)"
