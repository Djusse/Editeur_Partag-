#!/usr/bin/env bash
# Déploiement complet.
#
#  1. crée (si besoin) la paire de clés et les secrets SSM ;
#  2. déploie la pile CloudFormation (EC2 + nginx + Node, DynamoDB, S3, SQS) ;
#  3. construit l'application (backend + front statique) et l'archive ;
#  4. pousse l'archive dans S3 puis demande à l'instance de l'installer (SSM) ;
#  5. vérifie que /health répond.
#
# Usage :
#   KEY_NAME=cle-christian SES_SENDER="vous@gmail.com" ADMIN_CIDR="82.1.2.3/32" ./scripts/deploy.sh
#
# Aucune clé d'accès n'est nécessaire : `aws login` (ou un profil SSO) suffit.
#
# Points importants (voir infra/README-infra.md) :
#  - `ADMIN_CIDR` vide ou `0.0.0.0/0` **ferme** le port 22 (accès par Session
#    Manager). C'est le comportement voulu par le template : compatibilité
#    conservée avec les appels existants, mais plus aucune ouverture au monde.
#  - `KEY_NAME=""` déploie sans paire de clés (Session Manager uniquement).
#  - Chaque étape échoue franchement : plus de « Déploiement terminé » après un
#    échec silencieux.
set -euo pipefail

STACK_NAME="${STACK_NAME:-editeur}"
AWS_REGION="${AWS_REGION:-eu-north-1}"
# Par défaut, **aucune** paire de clés : le port 22 est fermé et l'accès passe
# par Session Manager. Une clé par défaut n'aurait servi à rien et écrivait un
# `.pem` à la racine du dépôt.
KEY_NAME="${KEY_NAME:-}"
SES_SENDER="${SES_SENDER:-}"
ADMIN_CIDR="${ADMIN_CIDR:-}"
# Le défaut est **défini ici et nulle part ailleurs** : il était auparavant
# `t3.large`, ce qui écrasait silencieusement le `Default` du template
# (`m7i-flex.large`) — le script passait toujours son propre paramètre, donc le
# template n'avait jamais voix au chapitre.
# `m7i-flex.large` : éligible au Free Tier, 2 vCPU / 8 Gio (même mémoire que la
# cible du plan v7). Surchargeable : INSTANCE_TYPE=t3.small ./scripts/deploy.sh
INSTANCE_TYPE="${INSTANCE_TYPE:-m7i-flex.large}"
PROPRIETAIRE="${PROPRIETAIRE:-Djusse Tameno Christian}"
PROJET="${PROJET:-editeur-documents-partage}"

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

if [[ -z "$SES_SENDER" ]]; then
  echo "ERREUR : renseignez SES_SENDER (adresse vérifiée dans SES)."
  echo "  KEY_NAME=... SES_SENDER=\"vous@gmail.com\" ./scripts/deploy.sh"
  exit 1
fi

for tool in node npm aws; do
  command -v "$tool" >/dev/null 2>&1 || { echo "Outil manquant : $tool"; exit 1; }
done

echo "==> 1/6 Région et identité AWS"
aws sts get-caller-identity --region "$AWS_REGION" --output text >/dev/null
ACCOUNT_ID="$(aws sts get-caller-identity --region "$AWS_REGION" --query Account --output text)"
echo "    compte $ACCOUNT_ID en $AWS_REGION"

# --- Éligibilité du type d'instance -------------------------------------------
# Inutile de lancer la pile pour la voir échouer après plusieurs minutes :
# un compte en Free Tier refuse `t3.large` avec « not eligible for Free Tier ».
echo "    type d'instance : $INSTANCE_TYPE"
if ! aws ec2 describe-instance-types --instance-types "$INSTANCE_TYPE" \
     --region "$AWS_REGION" \
     --query "InstanceTypes[].InstanceType" --output text 2>/dev/null | grep -q "$INSTANCE_TYPE"; then
  echo "ERREUR : le type $INSTANCE_TYPE n'existe pas dans $AWS_REGION."
  exit 1
fi

# Vérification **factuelle** auprès d'AWS plutôt qu'une liste tenue à la main :
# les types éligibles au Free Tier varient selon le compte et la région
# (m7i-flex.large l'est, t3.large ne l'est pas). On interroge l'API.
ELIGIBLE="$(aws ec2 describe-instance-types --instance-types "$INSTANCE_TYPE" \
  --region "$AWS_REGION" --filters "Name=free-tier-eligible,Values=true" \
  --query "InstanceTypes[].InstanceType" --output text 2>/dev/null || true)"

if [[ "$ELIGIBLE" == *"$INSTANCE_TYPE"* ]]; then
  echo "    éligible au Free Tier (vérifié auprès d'AWS) — 2 vCPU / RAM selon le type"
else
  echo "    AVERTISSEMENT : $INSTANCE_TYPE n'est pas éligible au Free Tier selon AWS."
  echo "      Sur un compte en Free Tier, la création échouera avec :"
  echo "      « The specified instance type is not eligible for Free Tier »."
  echo "      Types actuellement éligibles : ${ELIGIBLE:-aucun}"
  echo "      Pour un premier déploiement :"
  echo "        INSTANCE_TYPE=m7i-flex.large ./scripts/deploy.sh   # 2 vCPU / 8 Gio"
  echo "      (poursuite dans 5 s — Ctrl+C pour annuler)"
  sleep 5
fi

echo "==> 2/6 Paire de clés et secrets"
if [[ -n "$KEY_NAME" ]]; then
  if ! aws ec2 describe-key-pairs --key-names "$KEY_NAME" --region "$AWS_REGION" >/dev/null 2>&1; then
    echo "    création de la paire $KEY_NAME (fichier $KEY_NAME.pem dans le dossier courant)"
    aws ec2 create-key-pair --key-name "$KEY_NAME" --region "$AWS_REGION" \
      --query KeyMaterial --output text > "$KEY_NAME.pem"
    chmod 400 "$KEY_NAME.pem"
    echo "    ATTENTION : conservez $KEY_NAME.pem, il ne sera plus téléchargeable."
  else
    echo "    paire $KEY_NAME déjà présente"
  fi
else
  echo "    aucune paire de clés : accès par Session Manager uniquement"
fi

# Secrets : créés une seule fois, jamais présents dans le dépôt ni le template.
if ! aws ssm get-parameter --name /editeur/jwt-secret --region "$AWS_REGION" >/dev/null 2>&1; then
  aws ssm put-parameter --name /editeur/jwt-secret --type SecureString \
    --value "$(openssl rand -base64 48)" --region "$AWS_REGION" >/dev/null
  echo "    /editeur/jwt-secret créé"
else
  echo "    /editeur/jwt-secret conservé"
fi
if ! aws ssm get-parameter --name /editeur/admin-key --region "$AWS_REGION" >/dev/null 2>&1; then
  aws ssm put-parameter --name /editeur/admin-key --type SecureString \
    --value "$(openssl rand -hex 16)" --region "$AWS_REGION" >/dev/null
  echo "    /editeur/admin-key créé"
else
  echo "    /editeur/admin-key conservé"
fi

echo "==> 3/6 Déploiement de la pile CloudFormation"

# Une pile en ROLLBACK_COMPLETE ne peut plus être mise à jour : `deploy` échoue
# avec « is in ROLLBACK_COMPLETE state and can not be updated ». C'est l'état que
# laisse **tout** échec de création (quota, type d'instance, user data). On la
# supprime avant de recréer : le rollback a déjà détruit les ressources, seule
# l'enveloppe de la pile subsiste.
STACK_STATE="$(aws cloudformation describe-stacks --stack-name "$STACK_NAME" \
  --region "$AWS_REGION" --query "Stacks[0].StackStatus" --output text 2>/dev/null || true)"
case "$STACK_STATE" in
  ROLLBACK_COMPLETE|ROLLBACK_FAILED|CREATE_FAILED)
    echo "    pile en $STACK_STATE (échec antérieur) — suppression puis recréation"
    aws cloudformation delete-stack --stack-name "$STACK_NAME" --region "$AWS_REGION"
    if ! aws cloudformation wait stack-delete-complete --stack-name "$STACK_NAME" --region "$AWS_REGION"; then
      echo "ERREUR : la suppression de la pile $STACK_STATE a échoué."
      aws cloudformation describe-stack-events --stack-name "$STACK_NAME" --region "$AWS_REGION" \
        --query "StackEvents[?ResourceStatus=='DELETE_FAILED'].[LogicalResourceId,ResourceStatusReason]" \
        --output table || true
      exit 1
    fi
    echo "    pile supprimée — recréation"
    ;;
esac

# Les balises se propagent à toutes les ressources qui les supportent.
aws cloudformation deploy \
  --template-file infra/template.yaml \
  --stack-name "$STACK_NAME" \
  --region "$AWS_REGION" \
  --capabilities CAPABILITY_IAM CAPABILITY_NAMED_IAM \
  --parameter-overrides \
      KeyName="$KEY_NAME" \
      AdminCidr="$ADMIN_CIDR" \
      InstanceType="$INSTANCE_TYPE" \
      SesSenderEmail="$SES_SENDER" \
  --tags "Projet=$PROJET" "Proprietaire=$PROPRIETAIRE" \
  --no-fail-on-empty-changeset

INSTANCE_ID="$(aws cloudformation describe-stacks --stack-name "$STACK_NAME" --region "$AWS_REGION" \
  --query "Stacks[0].Outputs[?OutputKey=='InstanceId'].OutputValue" --output text)"
BUCKET="$(aws cloudformation describe-stacks --stack-name "$STACK_NAME" --region "$AWS_REGION" \
  --query "Stacks[0].Outputs[?OutputKey=='BucketName'].OutputValue" --output text)"
PUBLIC_IP="$(aws cloudformation describe-stacks --stack-name "$STACK_NAME" --region "$AWS_REGION" \
  --query "Stacks[0].Outputs[?OutputKey=='PublicIp'].OutputValue" --output text)"

if [[ -z "$INSTANCE_ID" || -z "$BUCKET" || -z "$PUBLIC_IP" ]]; then
  echo "ERREUR : sorties de pile introuvables (InstanceId, BucketName, PublicIp)."
  echo "  Vérifiez : aws cloudformation describe-stacks --stack-name $STACK_NAME --region $AWS_REGION"
  exit 1
fi
echo "    instance $INSTANCE_ID — $PUBLIC_IP — bucket $BUCKET"

echo "==> 4/6 Construction de l'application"
# Un `.next` résiduel d'un `next dev` fige une URL localhost dans les chunks :
# le front appellerait alors l'API sur la mauvaise origine. On repart propre.
# Nettoyage **avant** le contrôle d'espace : `node_modules` et `.next` d'un
# essai précédent occupent ~620 Mio et ne servent plus. Les laisser ferait
# échouer le contrôle alors qu'il suffit de les supprimer — c'était le cas au
# deuxième déploiement de CloudShell.
rm -rf frontend/.next frontend/out backend/dist backend/node_modules frontend/node_modules build app.tar.gz

# --- Contrôle d'espace ---------------------------------------------------
# CloudShell ne dispose que d'environ 1 Gio dans `$HOME`. On échoue tôt, avec
# un message actionnable, plutôt qu'au milieu d'un `npm ci`.
#
# Le pic réel a été mesuré à ~880 Mio (backend 166 + frontend 448 + .next 105
# + build 70 + sources), ce qui dépassait une première estimation à 800 : le
# déploiement échouait en `ENOSPC` juste après le `next build`. D'où le seuil
# relevé et, surtout, la suppression des `node_modules` **au fur et à mesure**.
NEED_MB=900
AVAIL_MB="$(df -Pm "$ROOT" | awk 'NR==2 {print $4}')"
echo "    espace libre : ${AVAIL_MB} Mio (requis ~${NEED_MB} Mio)"
if [[ -n "$AVAIL_MB" && "$AVAIL_MB" -lt "$NEED_MB" ]]; then
  echo "ERREUR : espace insuffisant dans $ROOT (${AVAIL_MB} Mio libres, ~${NEED_MB} requis)."
  echo "  Options :"
  echo "    - libérer de la place : rm -rf ~/Editeur_Partag-/{build,app.tar.gz,backend/node_modules,frontend/node_modules,frontend/.next}"
  echo "    - CloudShell plafonne le home à 1 Gio : un second déploiement dans le"
  echo "      même home est donc limite. Le script nettoie normalement derrière lui."
  exit 1
fi

# --- Backend : build puis libération immédiate de ses dépendances ------------
(cd backend && npm ci --no-audit --no-fund && npm run build)
dist_ok=0
[[ -f backend/dist/server/main.mjs && -f backend/dist/server/worker.mjs ]] && dist_ok=1
if [[ "$dist_ok" -ne 1 ]]; then
  echo "ERREUR : backend/dist/server/{main,worker}.mjs absents — le build a échoué."
  exit 1
fi
# 166 Mio rendus au disque : ils ne servent plus, le bundle est autonome
# (`--packages=external`, les dépendances sont réinstallées dans build/ plus bas).
rm -rf backend/node_modules
echo "    backend : dist construit, node_modules libéré"

# --- Frontend : build puis libération immédiate ------------------------------
(cd frontend && npm ci --no-audit --no-fund && npm run build)

# Garde-fou : sans export statique, nginx n'aurait aucun fichier à servir.
if [[ ! -d frontend/out ]]; then
  echo "ERREUR : frontend/out absent — l'export statique a échoué."
  exit 1
fi

# Les variables NEXT_PUBLIC_* sont inlinées : on vérifie qu'aucune URL locale
# n'a fui dans les chunks.
if grep -rq "localhost:4000" frontend/out 2>/dev/null; then
  echo "ERREUR : le bundle client contient localhost:4000."
  echo "  Lancez : node tests/node/verify-client-bundle.mjs"
  exit 1
fi

# `out/` est copié d'abord dans build/, puis les 448 Mio de dépendances de
# build (Next.js, TypeScript…) sont libérés : le reste du script n'en a plus
# besoin, et c'est ce qui permet de tenir dans le gigaoctet de CloudShell.
rm -rf build && mkdir -p build
cp -r backend/dist build/dist
cp backend/package.json build/package.json
cp -r frontend/out build/public

rm -rf frontend/node_modules frontend/.next
echo "    frontend : out/ copié, node_modules libéré"

# Dépendances de production uniquement (pdfkit, ws, yjs, SDK AWS…).
(cd build && npm install --omit=dev --no-audit --no-fund --ignore-scripts)
tar -czf app.tar.gz -C build .

# --- Libération de l'espace -------------------------------------------------
# `node_modules` et `.next` ne servent plus une fois l'archive créée, et ils
# occupent ~620 Mio : les garder fait échouer le déploiement suivant sur un
# disque de 1 Gio. On les supprime après avoir vérifié que l'archive existe.
if [[ -s app.tar.gz ]]; then
  rm -rf frontend/.next frontend/node_modules backend/node_modules build
  echo "    espace libéré (node_modules et .next supprimés)"
else
  echo "ERREUR : app.tar.gz absent ou vide — rien n'a été envoyé."
  exit 1
fi

echo "==> 5/6 Envoi vers S3 et installation sur l'instance (SSM)"
aws s3 cp app.tar.gz "s3://$BUCKET/artifacts/app.tar.gz" --region "$AWS_REGION" >/dev/null

COMMAND_ID="$(aws ssm send-command \
  --instance-ids "$INSTANCE_ID" \
  --region "$AWS_REGION" \
  --document-name AWS-RunShellScript \
  --comment "Deploiement editeur" \
  --parameters 'commands=[
    "set -e",
    "rm -rf /opt/editeur/dist /opt/editeur/public /opt/editeur/node_modules",
    "aws s3 cp s3://'"$BUCKET"'/artifacts/app.tar.gz /tmp/app.tar.gz --region '"$AWS_REGION"'",
    "cd /opt/editeur && tar -xzf /tmp/app.tar.gz",
    "chown -R ec2-user:ec2-user /opt/editeur",
    "systemctl restart editeur-app editeur-worker",
    "sleep 2",
    "systemctl is-active editeur-app editeur-worker"
  ]' \
  --query "Command.CommandId" --output text)"

echo "    commande SSM $COMMAND_ID"

INSTALL_STATUS="Pending"
for _ in $(seq 1 60); do
  INSTALL_STATUS="$(aws ssm get-command-invocation --command-id "$COMMAND_ID" \
    --instance-id "$INSTANCE_ID" --region "$AWS_REGION" \
    --query Status --output text 2>/dev/null || echo Pending)"
  case "$INSTALL_STATUS" in
    Success) break ;;
    Failed|Cancelled|TimedOut|Undeliverable)
      echo "ERREUR : installation SSM en échec (statut : $INSTALL_STATUS)"
      echo "--- sortie d'erreur ---"
      aws ssm get-command-invocation --command-id "$COMMAND_ID" \
        --instance-id "$INSTANCE_ID" --region "$AWS_REGION" \
        --query StandardErrorContent --output text || true
      exit 1
      ;;
  esac
  sleep 5
done

# La boucle peut expirer : sans ce test, le script annonçait un succès.
if [[ "$INSTALL_STATUS" != "Success" ]]; then
  echo "ERREUR : l'installation n'a pas abouti dans le délai imparti (statut : $INSTALL_STATUS)"
  exit 1
fi

echo "==> 6/6 Vérification"
HEALTH_OK=0
for _ in $(seq 1 20); do
  if curl -fsS "http://$PUBLIC_IP/health" >/dev/null 2>&1; then
    echo "    /health répond"
    HEALTH_OK=1
    break
  fi
  sleep 5
done

if [[ "$HEALTH_OK" -ne 1 ]]; then
  echo "ERREUR : l'application ne répond pas sur http://$PUBLIC_IP/health"
  echo "  Journaux : sudo tail -n 80 /var/log/editeur/app.log (via SSH ou Session Manager)"
  exit 1
fi

# Contrôle du **proxy visiteur**. Ces routes sont exposées à la racine, pas sous
# /api : si `location /d/` manque, nginx sert son propre 404 HTML au lieu de
# laisser répondre Node. On distingue donc les deux cas par le type de réponse,
# pas par le code HTTP (un jeton inexistant renvoie 404 dans les deux cas).
VISITOR_BODY="$(curl -s --max-time 10 "http://$PUBLIC_IP/d/inexistant/status" || true)"
if [[ "$VISITOR_BODY" == *'"error"'* || "$VISITOR_BODY" == *'"status"'* ]]; then
  echo "    proxy /d/ opérationnel (réponse JSON de Node)"
else
  echo "AVERTISSEMENT : /d/inexistant/status ne renvoie pas du JSON applicatif."
  echo "  Reçu : ${VISITOR_BODY:0:120}"
  echo "  Le routage nginx de /d/ est probablement absent (404 HTML servi par nginx)."
fi

# Micro-cache : la preuve attendue est « HIT » au second appel rapproché.
CACHE_1="$(curl -s -o /dev/null -D - --max-time 10 "http://$PUBLIC_IP/d/inexistant/status" \
  | tr -d '\r' | awk -F': ' 'tolower($1)=="x-cache-status"{print $2}' || true)"
if [[ -n "$CACHE_1" ]]; then
  echo "    X-Cache-Status : $CACHE_1"
else
  echo "AVERTISSEMENT : aucun en-tête X-Cache-Status — le micro-cache /status n'est pas actif."
fi

ADMIN_KEY="$(aws ssm get-parameter --name /editeur/admin-key --with-decryption \
  --region "$AWS_REGION" --query Parameter.Value --output text)"

rm -f app.tar.gz
echo
echo "Déploiement terminé."
echo "  Application  : http://$PUBLIC_IP"
echo "  Supervision  : http://$PUBLIC_IP/admin   (clé : $ADMIN_KEY)"
echo "  Instance     : $INSTANCE_ID"
echo
echo "Contrôles recommandés :"
echo "  curl -s http://$PUBLIC_IP/d/<token>/status"
echo "  curl -sI http://$PUBLIC_IP/d/<token>/status | grep X-Cache-Status   # HIT au 2e appel"
echo "  Journaux : sudo tail -f /var/log/editeur/app.log (SSH ou Session Manager)"
