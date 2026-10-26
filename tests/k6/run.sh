#!/bin/bash
# Lanceur des scénarios k6.
#
# Pourquoi un lanceur : k6 n'a pas d'API de système de fichiers sans
# `--compatibility-mode`, donc il ne peut pas créer `tests/results/` lui-même.
# Sans ce dossier, il signale `failed to handle the end-of-test summary` et
# **perd le résumé JSON** — le verdict reste affiché, mais rien n'est conservé
# pour le rapport. Ce script crée le dossier une fois pour toutes.
#
# Usage :
#   ./tests/k6/run.sh s1 -e TOKEN=… -e MAX_DOWNLOADS=500 -e VISITORS=15000
#   ./tests/k6/run.sh s2 -e TOKEN=… -e DOC_ID=doc_… -e WRITERS=100
#   ./tests/k6/run.sh s5 -e TOKEN=… -e DOC_ID=doc_… -e WRITERS=300
#   ./tests/k6/run.sh s7 -e TOKEN=… -e DOC_ID=doc_… -e INSTANCE=i-…
#
# Variables communes lues dans l'environnement :
#   API_URL (défaut http://localhost:4000), K6 (chemin du binaire).
set -uo pipefail

SCENARIO="${1:-}"
shift || true

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"

K6="${K6:-k6}"
API_URL="${API_URL:-http://localhost:4000}"

if ! command -v "$K6" >/dev/null 2>&1; then
  if [ -x /usr/local/bin/k6 ]; then
    K6=/usr/local/bin/k6
  else
    echo "ERREUR : k6 introuvable. Lancer tests/k6/install-k6.sh" >&2
    exit 1
  fi
fi

# Le dossier de résultats doit exister AVANT le test : k6 écrit le résumé à la
# fin, et refuse silencieusement si le chemin est absent.
mkdir -p tests/results

# Banque d'updates distincts pour S2 : SANS elle, le scénario s'arrête à
# l'inspection (`stat …/updates.json`). Envoyer le même payload à tous les VUs
# ne produit pas de la concurrence : le serveur déduplique par empreinte, et les
# expéditeurs restent sans acquittement. Voir tests/k6/README.md.
if [ "$SCENARIO" = "s2" ]; then
  if [ ! -s tests/k6/data/updates.json ]; then
    echo "banque d'updates absente — génération…"
    if ! node tests/k6/gen-updates.mjs 20000 tests/k6/data/updates.json; then
      echo "ERREUR : génération impossible. Node et yjs (backend/) sont requis." >&2
      echo "  cd backend && npm install && cd .. && node tests/k6/gen-updates.mjs 20000 tests/k6/data/updates.json" >&2
      exit 1
    fi
  fi
fi

case "$SCENARIO" in
  s1) SCRIPT=tests/k6/s1-claim.js ;;
  s2) SCRIPT=tests/k6/s2-convergence.js ;;
  s5) SCRIPT=tests/k6/s5-mixte.js ;;
  s7) SCRIPT=tests/k6/s7-robustesse.sh ;;
  *)
    echo "Usage : $0 <s1|s2|s5|s7> [-e VAR=…] …" >&2
    exit 1
    ;;
esac

echo "scénario : $SCENARIO"
echo "API_URL  : $API_URL"
echo "k6       : $($K6 version)"
echo "résultats: $ROOT/tests/results/"
echo

if [ "$SCENARIO" = "s7" ]; then
  # S7 est un script shell qui orchestre k6 et un kill -9 par SSM.
  exec bash "$SCRIPT" "$@"
fi

# `-e API_URL` toujours transmis : les scénarios ne figent aucune adresse.
exec "$K6" run -e API_URL="$API_URL" "$@" "$SCRIPT"
