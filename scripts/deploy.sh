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
INSTANCE_TYPE="${INSTANCE_TYPE:-t3.large}"
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
rm -rf frontend/.next frontend/out backend/dist build app.tar.gz

(cd backend && npm ci --no-audit --no-fund && npm run build)
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

rm -rf build && mkdir -p build
cp -r backend/dist build/dist
cp backend/package.json build/package.json
# Dépendances de production uniquement (pdfkit, ws, yjs, SDK AWS…).
(cd build && npm install --omit=dev --no-audit --no-fund --ignore-scripts)
cp -r frontend/out build/public
tar -czf app.tar.gz -C build .

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
