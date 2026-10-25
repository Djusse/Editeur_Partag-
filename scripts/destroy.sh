#!/usr/bin/env bash
# Suppression complète et vérifiée.
#
# Pourquoi un script dédié : `aws cloudformation delete-stack` échoue sur le
# bucket parce qu'il est **versionné** (`DeletionPolicy: Delete` ne vide rien).
# Les paramètres SSM et la paire de clés vivent en dehors de la pile et
# subsistent après coup. Sans ce script, on laisse des ressources facturables.
#
# Étapes :
#   1. inventaire de ce qui existe ;
#   2. purge du bucket (objets **et** versions, y compris marqueurs de suppression) ;
#   3. suppression de la pile puis attente de fin ;
#   4. suppression des paramètres SSM, de la paire de clés et de la file SQS ;
#   5. vérification finale : plus rien ne doit rester.
#
# Usage :
#   ./scripts/destroy.sh                 # demande confirmation
#   ./scripts/destroy.sh --yes           # sans confirmation (CI)
#   STACK_NAME=autre ./scripts/destroy.sh
set -euo pipefail

STACK_NAME="${STACK_NAME:-editeur}"
AWS_REGION="${AWS_REGION:-eu-north-1}"
KEY_NAME="${KEY_NAME:-cle-christian}"
ASSUME_YES=0
[[ "${1:-}" == "--yes" || "${1:-}" == "-y" ]] && ASSUME_YES=1

for tool in aws node; do
  command -v "$tool" >/dev/null 2>&1 || { echo "Outil manquant : $tool"; exit 1; }
done

# L'API AWS renvoie la chaîne « None » (ou rien) quand une sortie n'existe pas :
# sans ce nettoyage, `[[ -n "$BUCKET" ]]` était vrai et le script tentait de
# purger un bucket nommé « None ».
blank_if_none() {
  case "${1:-}" in
    ''|None|null|ABSENTE) echo '' ;;
    *) echo "$1" ;;
  esac
}

echo "==> 1/5 Inventaire"
echo "    région : $AWS_REGION   pile : $STACK_NAME"

STACK_STATE="$(aws cloudformation describe-stacks --stack-name "$STACK_NAME" \
  --region "$AWS_REGION" --query "Stacks[0].StackStatus" --output text 2>/dev/null || true)"
STACK_STATE="$(blank_if_none "$STACK_STATE")"
STACK_STATE="${STACK_STATE:-ABSENTE}"
echo "    pile          : $STACK_STATE"

BUCKET="$(aws cloudformation describe-stacks --stack-name "$STACK_NAME" --region "$AWS_REGION" \
  --query "Stacks[0].Outputs[?OutputKey=='BucketName'].OutputValue" --output text 2>/dev/null || true)"
BUCKET="$(blank_if_none "$BUCKET")"

KEY_STATE="absente"
aws ec2 describe-key-pairs --key-names "$KEY_NAME" --region "$AWS_REGION" >/dev/null 2>&1 \
  && KEY_STATE="présente"
echo "    paire de clés : $KEY_NAME ($KEY_STATE)"

SSM_FOUND=""
for param in /editeur/jwt-secret /editeur/admin-key; do
  if aws ssm get-parameter --name "$param" --region "$AWS_REGION" >/dev/null 2>&1; then
    SSM_FOUND="$SSM_FOUND $param"
  fi
done
echo "    paramètres SSM :${SSM_FOUND:- aucun}"

if [[ -n "$BUCKET" ]]; then
  echo "    bucket        : $BUCKET"
fi

if [[ "$STACK_STATE" == "ABSENTE" && -z "$BUCKET" && "$KEY_STATE" == "absente" && -z "$SSM_FOUND" ]]; then
  echo
  echo "Rien à supprimer : la pile, le bucket, la paire de clés et les secrets sont absents."
  exit 0
fi

if [[ "$ASSUME_YES" -ne 1 ]]; then
  echo
  echo "Cette opération est IRRÉVERSIBLE :"
  echo "  - documents, journal, crédits, versions, PDF et liens seront perdus ;"
  echo "  - la paire de clés SSH sera supprimée."
  read -r -p "Tapez « supprimer » pour confirmer : " answer
  [[ "$answer" == "supprimer" ]] || { echo "Annulé."; exit 1; }
fi

echo
echo "==> 2/5 Purge du bucket (objets et versions)"

# Purge réutilisable : après un `delete-stack` en échec, l'application a pu
# réécrire dans le bucket entre-temps, il faut donc pouvoir la relancer.
purge_bucket() {
  if [[ -z "$BUCKET" ]]; then
    echo "    bucket inconnu (pile absente) — rien à purger"
    return 0
  fi
  if ! aws s3api head-bucket --bucket "$BUCKET" --region "$AWS_REGION" >/dev/null 2>&1; then
    echo "    bucket $BUCKET absent ou déjà supprimé"
    return 0
  fi
  node - "$BUCKET" "$AWS_REGION" <<'NODE'
const { execFileSync } = require('node:child_process');
const { mkdtempSync, writeFileSync, rmSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');

const [bucket, region] = process.argv.slice(2);

const aws = (args) =>
  execFileSync('aws', [...args, '--region', region, '--output', 'json'], { encoding: 'utf8' });

// 200 objets par lot, jamais 900 : un argument de ligne de commande est plafonné
// à ~128 Kio (MAX_ARG_STRLEN) et 900 clés de 70 caractères frisent la limite —
// `Argument list too long` après un test de charge. Le JSON passe de toute façon
// par un fichier (`--delete file://…`), ce qui supprime le risque.
const BATCH = 200;
const workdir = mkdtempSync(join(tmpdir(), 'purge-s3-'));

let deleted = 0;
try {
  for (;;) {
    const listed = JSON.parse(
      aws(['s3api', 'list-object-versions', '--bucket', bucket, '--max-keys', String(BATCH * 4)]),
    );
    const entries = [];
    for (const v of listed.Versions ?? []) entries.push({ Key: v.Key, VersionId: v.VersionId });
    for (const m of listed.DeleteMarkers ?? []) entries.push({ Key: m.Key, VersionId: m.VersionId });
    if (entries.length === 0) break;

    let sent = false;
    for (let index = 0; index < entries.length; index += BATCH) {
      const chunk = entries.slice(index, index + BATCH);
      const file = join(workdir, `delete-${index}.json`);
      writeFileSync(file, JSON.stringify({ Objects: chunk, Quiet: true }));
      aws(['s3api', 'delete-objects', '--bucket', bucket, '--delete', `file://${file}`]);
      deleted += chunk.length;
      sent = true;
      process.stdout.write(`    ${deleted} version(s) supprimée(s)\n`);
    }
    if (!sent) break;
  }
} finally {
  rmSync(workdir, { recursive: true, force: true });
}

console.log(`    bucket vide (${deleted} version(s) au total)`);
NODE
}

purge_bucket

echo
echo "==> 3/5 Suppression de la pile"
if [[ "$STACK_STATE" != "ABSENTE" ]]; then
  # Entre la purge et ce `delete-stack`, l'application tourne encore : elle peut
  # réécrire dans le bucket (PDF, snapshots) et faire échouer la suppression du
  # bucket. On réessaie donc une fois, après une nouvelle purge. Deux tentatives
  # suffisent : la seconde suit l'arrêt effectif des services.
  ATTEMPT=1
  while :; do
    aws cloudformation delete-stack --stack-name "$STACK_NAME" --region "$AWS_REGION"
    echo "    suppression lancée (tentative $ATTEMPT), attente…"
    if aws cloudformation wait stack-delete-complete --stack-name "$STACK_NAME" --region "$AWS_REGION"; then
      echo "    pile supprimée"
      break
    fi

    echo "    échec de la suppression — diagnostic :"
    aws cloudformation describe-stack-events --stack-name "$STACK_NAME" --region "$AWS_REGION" \
      --query "StackEvents[?ResourceStatus=='DELETE_FAILED'].[LogicalResourceId,ResourceStatusReason]" \
      --output table || echo "    (événements indisponibles)"

    if [[ "$ATTEMPT" -ge 2 ]]; then
      echo "ERREUR : la suppression de la pile a échoué deux fois."
      echo "  Causes fréquentes : bucket réécrit par l'application, ENI ou EIP encore attachées."
      exit 1
    fi

    ATTEMPT=$((ATTEMPT + 1))
    echo "    nouvelle purge du bucket puis seconde tentative…"
    purge_bucket
  done
else
  echo "    pile déjà absente"
fi

echo
echo "==> 4/5 Paramètres SSM, paire de clés, files SQS résiduelles"
for param in $SSM_FOUND; do
  aws ssm delete-parameter --name "$param" --region "$AWS_REGION" >/dev/null
  echo "    $param supprimé"
done

if [[ "$KEY_STATE" == "présente" ]]; then
  aws ec2 delete-key-pair --key-name "$KEY_NAME" --region "$AWS_REGION" >/dev/null
  echo "    paire $KEY_NAME supprimée"
  [[ -f "$KEY_NAME.pem" ]] && echo "    (le fichier local $KEY_NAME.pem existe encore : à supprimer vous-même)"
fi

# Les files SQS sont dans la pile, mais un déploiement interrompu peut en laisser.
REMAINING_QUEUES="$(aws sqs list-queues --region "$AWS_REGION" --queue-name-prefix editeur \
  --query "QueueUrls[]" --output text 2>/dev/null || true)"
for url in $REMAINING_QUEUES; do
  aws sqs delete-queue --queue-url "$url" --region "$AWS_REGION" >/dev/null
  echo "    file supprimée : $url"
done

echo
echo "==> 5/5 Vérification finale"
LEFTOVERS=0
# Une commande en échec ne doit **jamais** compter comme « rien ne reste » :
# c'était le défaut principal de cette section. `check` distingue trois états.
ERRORS=0

check() {
  local label="$1" status="$2" result="$3"
  case "$status" in
    0)
      if [[ -n "$result" && "$result" != "None" && "$result" != "[]" ]]; then
        echo "    RESTE  $label : $result"
        LEFTOVERS=$((LEFTOVERS + 1))
      else
        echo "    OK     $label"
      fi
      ;;
    *)
      # Code retour 254 = « ressource absente » côté AWS CLI, pas une erreur.
      if [[ "$status" == "254" ]]; then
        echo "    OK     $label (absente)"
      else
        echo "    ERREUR $label — le contrôle a échoué (code $status), état inconnu"
        ERRORS=$((ERRORS + 1))
      fi
      ;;
  esac
}

# Vérifie une liste d'identifiants.
#
# `set -e` est actif : sans le `set +e` ci-dessous, une commande AWS en échec
# faisait sortir le script **immédiatement**, avec le code de l'outil (252…)
# au lieu du nôtre, et sans afficher le bilan. La gestion d'erreur ne servait
# donc à rien dans le cas même qu'elle devait couvrir.
check_cmd() {
  local label="$1"; shift
  local out status
  set +e
  out="$("$@" 2>/dev/null)"
  status=$?
  set -e
  check "$label" "$status" "$out"
}

check_cmd "pile CloudFormation" aws cloudformation describe-stacks --stack-name "$STACK_NAME" \
  --region "$AWS_REGION" --query "Stacks[0].StackName" --output text

check_cmd "instances" aws ec2 describe-instances --region "$AWS_REGION" \
  --filters "Name=tag:Projet,Values=editeur-documents-partage" \
            "Name=instance-state-name,Values=pending,running,stopping,stopped" \
  --query "Reservations[].Instances[].InstanceId" --output text

check_cmd "adresses Elastic" aws ec2 describe-addresses --region "$AWS_REGION" \
  --query "Addresses[].PublicIp" --output text

# Les tables n'ont pas de `TableName` explicite dans le template : CloudFormation
# les nomme `editeur-DocumentsTable-XXXXX` (préfixe = nom de pile). Chercher les
# préfixes logiques (`Documents`, `Members`…) ne matchait donc jamais et le
# contrôle affichait toujours OK.
check_cmd "tables DynamoDB" aws dynamodb list-tables --region "$AWS_REGION" \
  --query "TableNames[?starts_with(@, '${STACK_NAME}-')]" --output text

check_cmd "buckets" aws s3api list-buckets --region "$AWS_REGION" \
  --query "Buckets[?starts_with(Name, 'editeur-')].Name" --output text

check_cmd "files SQS" aws sqs list-queues --region "$AWS_REGION" \
  --queue-name-prefix editeur --query "QueueUrls[]" --output text

# `Key=Path` + `Option=Recursive` est la seule combinaison valide pour un
# préfixe. `Key=Name` n'accepte que `Equals`/`BeginsWith` : la forme précédente
# (`Key=Name,Option=Recursive`) était rejetée par l'API, et le `|| true`
# masquait l'échec — le contrôle affichait OK sans avoir rien interrogé.
check_cmd "paramètres SSM" aws ssm describe-parameters --region "$AWS_REGION" \
  --parameter-filters "Key=Path,Option=Recursive,Values=/editeur" \
  --query "Parameters[].Name" --output text

check_cmd "groupes de logs" aws logs describe-log-groups --region "$AWS_REGION" \
  --log-group-name-prefix /editeur --query "logGroups[].logGroupName" --output text

echo
if [[ "$ERRORS" -gt 0 ]]; then
  echo "$ERRORS contrôle(s) en erreur : l'état de ces ressources est INCONNU."
  echo "  Relancez les commandes ci-dessus à la main avant de conclure."
  exit 1
fi

if [[ "$LEFTOVERS" -eq 0 ]]; then
  echo "Suppression complète : aucune ressource facturable ne subsiste."
  exit 0
fi

echo "$LEFTOVERS ressource(s) restante(s) — voir ci-dessus."
echo "Rappel : les journaux CloudWatch disparaissent avec la pile ; exportez-les avant."
exit 1
