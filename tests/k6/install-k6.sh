#!/bin/bash
# Installe k6 sur Amazon Linux 2023.
#
# Pourquoi le binaire officiel plutôt que le dépôt RPM : AL2023 est dérivé de
# Fedora, et le dépôt `dl.k6.io/rpm` n'a pas toujours de paquet pour cette
# distribution. Le binaire statique, lui, fonctionne partout.
#
# Le script **n'avale pas les erreurs** : chaque étape est vérifiée, et un échec
# est signalé avec son code de sortie. Une installation silencieusement ratée
# coûte plus cher qu'une installation bruyante (leçon de la première tentative,
# où `dnf install ... >/dev/null` avait masqué l'échec).
set -uo pipefail

DEST="${DEST:-/usr/local/bin/k6}"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

step() { printf '\n--- %s\n' "$1"; }

fail() {
  echo "ECHEC : $1" >&2
  exit 1
}

# --- 1. Architecture ---------------------------------------------------------
step "architecture"
ARCH="$(uname -m)"
case "$ARCH" in
  x86_64|amd64) K6_ARCH="amd64" ;;
  aarch64|arm64) K6_ARCH="arm64" ;;
  *) fail "architecture non gérée : $ARCH" ;;
esac
echo "  $ARCH -> $K6_ARCH"

# --- 2. Dernière version publiée --------------------------------------------
step "recherche de la dernière version"
API="https://api.github.com/repos/grafana/k6/releases/latest"
URL="$(curl -fsSL "$API" \
  | grep -o "https://[^\"]*k6-v[0-9.]*-linux-${K6_ARCH}\.tar\.gz" \
  | head -1)"

if [ -z "$URL" ]; then
  # Repli : version figée, si l'API GitHub est rate-limitée (60 req/h sans jeton).
  URL="https://github.com/grafana/k6/releases/download/v0.54.0/k6-v0.54.0-linux-${K6_ARCH}.tar.gz"
  echo "  API indisponible, repli sur v0.54.0"
fi
echo "  $URL"

# --- 3. Téléchargement -------------------------------------------------------
step "téléchargement"
if ! curl -fsSL "$URL" -o "$TMP/k6.tar.gz"; then
  fail "téléchargement impossible depuis $URL"
fi
echo "  $(du -h "$TMP/k6.tar.gz" | cut -f1) reçus"

# --- 4. Extraction -----------------------------------------------------------
step "extraction"
if ! tar -xzf "$TMP/k6.tar.gz" -C "$TMP"; then
  fail "archive illisible"
fi

BIN="$(find "$TMP" -type f -name k6 -perm -u+x | head -1)"
if [ -z "$BIN" ]; then
  BIN="$(find "$TMP" -type f -name k6 | head -1)"
fi
[ -n "$BIN" ] || fail "binaire k6 introuvable dans l'archive"
echo "  trouvé : ${BIN#"$TMP"/}"

# --- 5. Installation ---------------------------------------------------------
step "installation dans $DEST"
if ! install -m 0755 "$BIN" "$DEST"; then
  fail "installation impossible (droits insuffisants ? lancer avec sudo)"
fi

# --- 6. Vérification ---------------------------------------------------------
step "vérification"
if ! "$DEST" version; then
  fail "le binaire installé ne s'exécute pas"
fi

# `PATH` peut ne pas contenir /usr/local/bin dans un shell SSM non interactif :
# on le signale, car la commande suivante échouerait de façon déroutante.
case ":$PATH:" in
  *":/usr/local/bin:"*) ;;
  *) echo "  ATTENTION : /usr/local/bin absent du PATH ; utiliser $DEST ou exporter PATH" ;;
esac

echo
echo "k6 installé : $DEST"
