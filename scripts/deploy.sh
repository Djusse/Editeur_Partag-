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
set -euo pipefail

STACK_NAME="${STACK_NAME:-editeur}"
AWS_REGION="${AWS_REGION:-eu-north-1}"
KEY_NAME="${KEY_NAME:-cle-christian}"
SES_SENDER="${SES_SENDER:-}"
ADMIN_CIDR="${ADMIN_CIDR:-0.0.0.0/0}"
INSTANCE_TYPE="${INSTANCE_TYPE:-t3.large}"

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
if ! aws ec2 describe-key-pairs --key-names "$KEY_NAME" --region "$AWS_REGION" >/dev/null 2>&1; then
  echo "    création de la paire $KEY_NAME (fichier $KEY_NAME.pem dans le dossier courant)"
  aws ec2 create-key-pair --key-name "$KEY_NAME" --region "$AWS_REGION" \
    --query KeyMaterial --output text > "$KEY_NAME.pem"
  chmod 400 "$KEY_NAME.pem"
  echo "    ATTENTION : conservez $KEY_NAME.pem, il ne sera plus téléchargeable."
fi

# Secrets : créés une seule fois, jamais présents dans le dépôt ni le template.
if ! aws ssm get-parameter --name /editeur/jwt-secret --region "$AWS_REGION" >/dev/null 2>&1; then
  aws ssm put-parameter --name /editeur/jwt-secret --type SecureString \
    --value "$(openssl rand -base64 48)" --region "$AWS_REGION" >/dev/null
  echo "    /editeur/jwt-secret créé"
fi
if ! aws ssm get-parameter --name /editeur/admin-key --region "$AWS_REGION" >/dev/null 2>&1; then
  aws ssm put-parameter --name /editeur/admin-key --type SecureString \
    --value "$(openssl rand -hex 16)" --region "$AWS_REGION" >/dev/null
  echo "    /editeur/admin-key créé"
fi

echo "==> 3/6 Déploiement de la pile CloudFormation"
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
  --no-fail-on-empty-changeset

INSTANCE_ID="$(aws cloudformation describe-stacks --stack-name "$STACK_NAME" --region "$AWS_REGION" \
  --query "Stacks[0].Outputs[?OutputKey=='InstanceId'].OutputValue" --output text)"
BUCKET="$(aws cloudformation describe-stacks --stack-name "$STACK_NAME" --region "$AWS_REGION" \
  --query "Stacks[0].Outputs[?OutputKey=='BucketName'].OutputValue" --output text)"
PUBLIC_IP="$(aws cloudformation describe-stacks --stack-name "$STACK_NAME" --region "$AWS_REGION" \
  --query "Stacks[0].Outputs[?OutputKey=='PublicIp'].OutputValue" --output text)"
echo "    instance $INSTANCE_ID — $PUBLIC_IP — bucket $BUCKET"

echo "==> 4/6 Construction de l'application"
(cd backend && npm ci --no-audit --no-fund && npm run build)
(cd frontend && npm ci --no-audit --no-fund && npm run build)

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
for _ in $(seq 1 30); do
  STATUS="$(aws ssm get-command-invocation --command-id "$COMMAND_ID" --instance-id "$INSTANCE_ID" \
    --region "$AWS_REGION" --query Status --output text 2>/dev/null || echo Pending)"
  [[ "$STATUS" == "Success" ]] && break
  [[ "$STATUS" == "Failed" || "$STATUS" == "Cancelled" ]] && {
    aws ssm get-command-invocation --command-id "$COMMAND_ID" --instance-id "$INSTANCE_ID" \
      --region "$AWS_REGION" --query StandardErrorContent --output text
    exit 1
  }
  sleep 5
done

echo "==> 6/6 Vérification"
for _ in $(seq 1 20); do
  if curl -fsS "http://$PUBLIC_IP/health" >/dev/null 2>&1; then
    echo "    /health répond"
    break
  fi
  sleep 5
done

ADMIN_KEY="$(aws ssm get-parameter --name /editeur/admin-key --with-decryption \
  --region "$AWS_REGION" --query Parameter.Value --output text)"

rm -f app.tar.gz
echo
echo "Déploiement terminé."
echo "  Application  : http://$PUBLIC_IP"
echo "  Supervision  : http://$PUBLIC_IP/admin   (clé : $ADMIN_KEY)"
echo "  Instance     : $INSTANCE_ID"
echo
echo "Journaux : sudo tail -f /var/log/editeur/app.log (via SSH ou Session Manager)"
