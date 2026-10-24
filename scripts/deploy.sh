#!/usr/bin/env bash
# Déploiement complet : infra SAM → build front → envoi S3 → invalidation CloudFront.
#
# Usage :
#   ./scripts/deploy.sh                      # premier déploiement (interactif)
#   ./scripts/deploy.sh --guided-off         # redéploiement sans prompt
#
# Variables : STACK_NAME (défaut), AWS_REGION (défaut eu-west-3), SES_SENDER (obligatoire).
set -euo pipefail

STACK_NAME="${STACK_NAME:-editeur-documents}"
AWS_REGION="${AWS_REGION:-eu-west-3}"
SES_SENDER="${SES_SENDER:-}"
GUIDED="${GUIDED:-false}"

if [[ "${1:-}" == "--guided-off" ]]; then
  GUIDED="false"
else
  GUIDED="true"
fi

if [[ -z "$SES_SENDER" ]]; then
  echo "ERREUR : renseignez SES_SENDER (adresse vérifiée dans SES), par exemple :"
  echo "  SES_SENDER=\"vous@gmail.com\" ./scripts/deploy.sh"
  exit 1
fi

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

echo "==> 1/6 Vérification de l'outillage"
for tool in node npm aws sam; do
  if ! command -v "$tool" >/dev/null 2>&1; then
    echo "Outil manquant : $tool"
    exit 1
  fi
done

echo "==> 2/6 Installation des dépendances"
(cd backend && npm ci --no-audit --no-fund)
(cd frontend && npm ci --no-audit --no-fund)

echo "==> 3/6 Compilation du backend (handlers bundlés)"
(cd backend && npm run bundle)

echo "==> 4/6 Déploiement de l'infrastructure (SAM)"
SAM_ARGS=(
  deploy
  --template-file infra/template.yaml
  --stack-name "$STACK_NAME"
  --region "$AWS_REGION"
  --capabilities CAPABILITY_IAM
  --resolve-s3
  --parameter-overrides "SesSenderEmail=$SES_SENDER WebOrigin=*"
  --no-fail-on-empty-changeset
)
if [[ "$GUIDED" == "true" ]]; then
  SAM_ARGS+=(--guided)
fi
sam "${SAM_ARGS[@]}"

echo "==> 5/6 Build du front statique et envoi vers S3"
API_URL="$(aws cloudformation describe-stacks --stack-name "$STACK_NAME" --region "$AWS_REGION" \
  --query "Stacks[0].Outputs[?OutputKey=='ApiUrl'].OutputValue" --output text)"
WS_URL="$(aws cloudformation describe-stacks --stack-name "$STACK_NAME" --region "$AWS_REGION" \
  --query "Stacks[0].Outputs[?OutputKey=='WebSocketUrl'].OutputValue" --output text)"
FRONT_BUCKET="$(aws cloudformation describe-stacks --stack-name "$STACK_NAME" --region "$AWS_REGION" \
  --query "Stacks[0].Outputs[?OutputKey=='FrontBucketName'].OutputValue" --output text)"
DISTRIBUTION_ID="$(aws cloudformation describe-stack-resource --stack-name "$STACK_NAME" --region "$AWS_REGION" \
  --logical-resource-id FrontDistribution --query "StackResourceDetail.PhysicalResourceId" --output text)"

(
  cd frontend
  NEXT_PUBLIC_API_BASE="$API_URL" NEXT_PUBLIC_WS_URL="$WS_URL" npm run build
)
aws s3 sync frontend/out "s3://$FRONT_BUCKET" --delete --region "$AWS_REGION"

echo "==> 6/6 Invalidation CloudFront"
aws cloudfront create-invalidation --distribution-id "$DISTRIBUTION_ID" --paths "/*" >/dev/null

# La variable WebOrigin est mise à jour avec l'URL réelle du front.
FRONT_URL="$(aws cloudformation describe-stacks --stack-name "$STACK_NAME" --region "$AWS_REGION" \
  --query "Stacks[0].Outputs[?OutputKey=='FrontDistributionDomain'].OutputValue" --output text)"
echo "==> Mise à jour de l'origine CORS : https://$FRONT_URL"
sam deploy --template-file infra/template.yaml --stack-name "$STACK_NAME" --region "$AWS_REGION" \
  --capabilities CAPABILITY_IAM --resolve-s3 --no-fail-on-empty-changeset \
  --parameter-overrides "SesSenderEmail=$SES_SENDER WebOrigin=https://$FRONT_URL"

echo
echo "Déploiement terminé."
echo "  Front        : https://$FRONT_URL"
echo "  API          : $API_URL"
echo "  WebSocket    : $WS_URL"
echo "  Bucket front : $FRONT_BUCKET"
