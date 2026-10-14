#!/usr/bin/env bash
#
# deploy-aws.sh : deploy the "order-request" stack to AWS with one command.
#
#   web     -> ECS Fargate behind an Application Load Balancer
#   worker  -> ECS Fargate (no load balancer)
#   db      -> Aurora PostgreSQL Serverless v2 (scales to 0 ACU / pauses when idle)
#
# Usage (run from your project root, where docker-compose.yml lives):
#   ./deploy-aws.sh            create or update everything (safe to re-run)
#   ./deploy-aws.sh status     show URL and service state
#   ./deploy-aws.sh destroy    delete everything (asks for confirmation)
#
# The ONLY manual step is logging in to AWS first:
#   aws configure sso && aws sso login        (company SSO)
#   aws configure                             (access keys)
#
# Requirements: AWS CLI v2 (recent), Docker with compose v2, bash (use WSL or Git Bash on Windows).
#
# Optional settings go in deploy/aws.config (plain shell, KEY=value), for example:
#   APP_NAME=order-request
#   AWS_REGION=ap-south-1
#   WEB_SERVICE=web
#   WORKER_SERVICE=worker
#   WEB_PORT=3000
#   HEALTH_PATH=/health
#   WEB_COMMAND=                              # JSON array, only if compose overrides the image CMD
#   WORKER_COMMAND='["node","worker.js"]'     # JSON array, only if compose overrides the image CMD
#   MIGRATE_COMMAND='["npm","run","migrate"]' # run once per deploy before services update
#   DB_NAME=appdb
#   DB_MAJOR=16                               # match your local postgres major version
#   CERT_ARN=arn:aws:acm:...                  # optional: enables HTTPS (needs a domain + ACM cert)
#   ALLOWED_CIDR=203.0.113.0/24               # optional: restrict who can reach the site (default: everyone)
#
# App configuration:
#   deploy/aws.env           plain env vars   (KEY=value per line)
#   deploy/aws.secrets.env   secrets          (KEY=value per line; stored encrypted in SSM Parameter Store)
# DATABASE_URL, DB_HOST, DB_PORT, DB_NAME, DB_USER, DB_PASSWORD, DB_SSL and PORT are set for you.

set -Eeuo pipefail
trap 'echo "Failed at line $LINENO" >&2' ERR
export AWS_PAGER="" MSYS_NO_PATHCONV=1   # MSYS_NO_PATHCONV stops Git Bash mangling "/paths"

# ----------------------------------------------------------------- config ---
CONFIG_FILE="${CONFIG_FILE:-deploy/aws.config}"
if [[ -f $CONFIG_FILE ]]; then
  # shellcheck disable=SC1090
  source "$CONFIG_FILE"
fi

APP_NAME="${APP_NAME:-order-request}"            # lowercase letters, digits, hyphens
AWS_REGION="${AWS_REGION:-${AWS_DEFAULT_REGION:-ap-south-1}}"
export AWS_DEFAULT_REGION="$AWS_REGION"

COMPOSE_FILE="${COMPOSE_FILE:-docker-compose.yml}"
WEB_SERVICE="${WEB_SERVICE:-web}"
WORKER_SERVICE="${WORKER_SERVICE:-worker}"
WEB_PORT="${WEB_PORT:-3000}"
HEALTH_PATH="${HEALTH_PATH:-/health}"
WEB_COMMAND="${WEB_COMMAND:-}"
WORKER_COMMAND="${WORKER_COMMAND:-}"
MIGRATE_COMMAND="${MIGRATE_COMMAND:-}"

WEB_CPU="${WEB_CPU:-256}";       WEB_MEMORY="${WEB_MEMORY:-512}"
WORKER_CPU="${WORKER_CPU:-256}"; WORKER_MEMORY="${WORKER_MEMORY:-512}"
WEB_COUNT="${WEB_COUNT:-1}";     WORKER_COUNT="${WORKER_COUNT:-1}"

DB_NAME="${DB_NAME:-appdb}"
DB_USER="${DB_USER:-appadmin}"
DB_MAJOR="${DB_MAJOR:-16}"
DB_ENGINE_VERSION="${DB_ENGINE_VERSION:-}"       # auto-detected (latest of DB_MAJOR) if empty
DB_MIN_ACU="${DB_MIN_ACU:-0}"                    # 0 = auto-pause when idle (cheapest)
DB_MAX_ACU="${DB_MAX_ACU:-2}"
DB_PAUSE_SECONDS="${DB_PAUSE_SECONDS:-300}"      # idle time before pausing (min 300)
DB_DELETION_PROTECTION="${DB_DELETION_PROTECTION:-true}"

CERT_ARN="${CERT_ARN:-}"
ALLOWED_CIDR="${ALLOWED_CIDR:-0.0.0.0/0}"
ENV_FILE="${ENV_FILE:-deploy/aws.env}"
SECRETS_FILE="${SECRETS_FILE:-deploy/aws.secrets.env}"
WORKDIR=".aws-deploy"                            # add to .gitignore

CLUSTER="$APP_NAME"
LOG_GROUP="/ecs/$APP_NAME"
SSM_PREFIX="/$APP_NAME"
DB_CLUSTER_ID="$APP_NAME-db"
DB_INSTANCE_ID="$APP_NAME-db-1"
DB_SUBNET_GROUP="$APP_NAME-db-subnets"
ALB_NAME="$APP_NAME-alb"
TG_NAME="$APP_NAME-web-tg"
EXEC_ROLE_NAME="$APP_NAME-ecs-exec"

# ---------------------------------------------------------------- helpers ---
log()  { printf '\033[1;34m==>\033[0m %s\n' "$*" >&2; }
warn() { printf '\033[1;33m!!\033[0m  %s\n' "$*" >&2; }
die()  { printf '\033[1;31mERROR:\033[0m %s\n' "$*" >&2; exit 1; }
need() { command -v "$1" >/dev/null 2>&1 || die "'$1' is not installed or not on PATH"; }
json_escape() { local s=$1; s=${s//\\/\\\\}; s=${s//\"/\\\"}; printf '%s' "$s"; }
join_by() { local IFS=,; printf '%s' "$*"; }

read_kv_file() {   # prints KEY<TAB>VALUE for each KEY=VALUE line
  local line k v
  [[ -f $1 ]] || return 0
  while IFS= read -r line || [[ -n $line ]]; do
    line=${line%$'\r'}
    if [[ -z $line || $line == \#* || $line != *=* ]]; then continue; fi
    k=${line%%=*}; v=${line#*=}
    v=${v%\"}; v=${v#\"}
    printf '%s\t%s\n' "$k" "$v"
  done < "$1"
}

preflight_aws() {
  need aws
  aws sts get-caller-identity >/dev/null 2>&1 \
    || die "Not logged in to AWS. Run:  aws configure sso && aws sso login   (or: aws configure)"
  ACCOUNT_ID=$(aws sts get-caller-identity --query Account --output text)
  log "AWS account $ACCOUNT_ID, region $AWS_REGION"
}

preflight_docker() {
  need docker
  docker info >/dev/null 2>&1 || die "Docker is not running."
  docker compose version >/dev/null 2>&1 || die "Docker compose v2 is required."
  [[ -f $COMPOSE_FILE ]] || die "'$COMPOSE_FILE' not found. Run this script from your project root."
}

# ---------------------------------------------------------------- network ---
lookup_network() {
  VPC_ID=$(aws ec2 describe-vpcs --filters Name=isDefault,Values=true --query 'Vpcs[0].VpcId' --output text)
  [[ $VPC_ID != None && -n $VPC_ID ]] || die "No default VPC in $AWS_REGION. Create one with: aws ec2 create-default-vpc"
  SUBNET_IDS=$(aws ec2 describe-subnets --filters Name=vpc-id,Values="$VPC_ID" Name=default-for-az,Values=true \
    --query 'Subnets[].SubnetId' --output text)
  SUBNET_CSV=$(echo "$SUBNET_IDS" | tr '\t' ',')
  [[ $(wc -w <<<"$SUBNET_IDS") -ge 2 ]] || die "Need default subnets in at least 2 availability zones."
}

find_sg() {
  local id
  id=$(aws ec2 describe-security-groups --filters Name=group-name,Values="$1" Name=vpc-id,Values="$VPC_ID" \
    --query 'SecurityGroups[0].GroupId' --output text 2>/dev/null || true)
  [[ $id == None ]] && id=""
  printf '%s' "$id"
}

ensure_sg() {
  local id; id=$(find_sg "$1")
  if [[ -z $id ]]; then
    id=$(aws ec2 create-security-group --group-name "$1" --description "$2" --vpc-id "$VPC_ID" \
      --query GroupId --output text)
  fi
  printf '%s' "$id"
}

allow_ingress() {   # sg port <--cidr X | --source-group Y>
  local sg=$1 port=$2 out; shift 2
  out=$(aws ec2 authorize-security-group-ingress --group-id "$sg" --protocol tcp --port "$port" "$@" 2>&1) || {
    [[ $out == *InvalidPermission.Duplicate* ]] || { echo "$out" >&2; exit 1; }
  }
}

step_network() {
  log "Network: default VPC $VPC_ID, security groups"
  ALB_SG=$(ensure_sg "$APP_NAME-alb" "ALB for $APP_NAME")
  APP_SG=$(ensure_sg "$APP_NAME-app" "ECS tasks for $APP_NAME")
  DB_SG=$(ensure_sg "$APP_NAME-db"  "Aurora for $APP_NAME")
  allow_ingress "$ALB_SG" 80  --cidr "$ALLOWED_CIDR"
  allow_ingress "$ALB_SG" 443 --cidr "$ALLOWED_CIDR"
  allow_ingress "$APP_SG" "$WEB_PORT" --source-group "$ALB_SG"
  allow_ingress "$DB_SG" 5432 --source-group "$APP_SG"
}

# -------------------------------------------------------------------- ECR ---
step_ecr() {
  ECR_HOST="$ACCOUNT_ID.dkr.ecr.$AWS_REGION.amazonaws.com"
  local svc repo
  for svc in web worker; do
    repo="$APP_NAME-$svc"
    if ! aws ecr describe-repositories --repository-names "$repo" >/dev/null 2>&1; then
      log "Creating ECR repository $repo"
      aws ecr create-repository --repository-name "$repo" --image-scanning-configuration scanOnPush=true >/dev/null
      aws ecr put-lifecycle-policy --repository-name "$repo" --lifecycle-policy-text \
        '{"rules":[{"rulePriority":1,"description":"keep last 5","selection":{"tagStatus":"any","countType":"imageCountMoreThan","countNumber":5},"action":{"type":"expire"}}]}' >/dev/null
    fi
  done
  WEB_IMAGE="$ECR_HOST/$APP_NAME-web:$TAG"
  WORKER_IMAGE="$ECR_HOST/$APP_NAME-worker:$TAG"
}

step_build() {
  log "Building and pushing images (tag $TAG, linux/amd64)"
  aws ecr get-login-password | docker login --username AWS --password-stdin "$ECR_HOST" >/dev/null
  cat > "$WORKDIR/compose.aws.yml" <<EOF
services:
  $WEB_SERVICE:
    image: $WEB_IMAGE
    platform: linux/amd64
  $WORKER_SERVICE:
    image: $WORKER_IMAGE
    platform: linux/amd64
EOF
  docker compose -f "$COMPOSE_FILE" -f "$WORKDIR/compose.aws.yml" build "$WEB_SERVICE" "$WORKER_SERVICE"
  docker compose -f "$COMPOSE_FILE" -f "$WORKDIR/compose.aws.yml" push "$WEB_SERVICE" "$WORKER_SERVICE"
}

# --------------------------------------------------------------- database ---
step_database() {
  log "Database: Aurora PostgreSQL Serverless v2"
  DB_PASSWORD=$(aws ssm get-parameter --name "$SSM_PREFIX/DB_PASSWORD" --with-decryption \
    --query Parameter.Value --output text 2>/dev/null || true)
  if [[ -z $DB_PASSWORD ]]; then
    DB_PASSWORD=$(openssl rand -hex 20 2>/dev/null || python3 -c 'import secrets;print(secrets.token_hex(20))')
    aws ssm put-parameter --name "$SSM_PREFIX/DB_PASSWORD" --type SecureString --value "$DB_PASSWORD" >/dev/null
  fi

  if ! aws rds describe-db-subnet-groups --db-subnet-group-name "$DB_SUBNET_GROUP" >/dev/null 2>&1; then
    # shellcheck disable=SC2086
    aws rds create-db-subnet-group --db-subnet-group-name "$DB_SUBNET_GROUP" \
      --db-subnet-group-description "$APP_NAME" --subnet-ids $SUBNET_IDS >/dev/null
  fi

  if ! aws rds describe-db-clusters --db-cluster-identifier "$DB_CLUSTER_ID" >/dev/null 2>&1; then
    if [[ -z $DB_ENGINE_VERSION ]]; then
      DB_ENGINE_VERSION=$(aws rds describe-db-engine-versions --engine aurora-postgresql \
        --query "DBEngineVersions[?starts_with(EngineVersion, '${DB_MAJOR}.')].EngineVersion" --output text \
        | tr '\t' '\n' | sort -V | tail -1)
      [[ -n $DB_ENGINE_VERSION ]] || die "No Aurora PostgreSQL $DB_MAJOR version found in $AWS_REGION."
    fi
    local scaling="MinCapacity=$DB_MIN_ACU,MaxCapacity=$DB_MAX_ACU"
    if [[ $DB_MIN_ACU == 0 ]]; then scaling+=",SecondsUntilAutoPause=$DB_PAUSE_SECONDS"; fi
    local protect=--no-deletion-protection
    if [[ $DB_DELETION_PROTECTION == true ]]; then protect=--deletion-protection; fi

    log "Creating Aurora cluster (engine $DB_ENGINE_VERSION, ACU $DB_MIN_ACU-$DB_MAX_ACU). This takes about 10 minutes."
    aws rds create-db-cluster --db-cluster-identifier "$DB_CLUSTER_ID" \
      --engine aurora-postgresql --engine-version "$DB_ENGINE_VERSION" \
      --master-username "$DB_USER" --master-user-password "$DB_PASSWORD" --database-name "$DB_NAME" \
      --db-subnet-group-name "$DB_SUBNET_GROUP" --vpc-security-group-ids "$DB_SG" \
      --serverless-v2-scaling-configuration "$scaling" \
      --backup-retention-period 7 --storage-encrypted "$protect" >/dev/null
  fi

  if ! aws rds describe-db-instances --db-instance-identifier "$DB_INSTANCE_ID" >/dev/null 2>&1; then
    aws rds create-db-instance --db-instance-identifier "$DB_INSTANCE_ID" \
      --db-cluster-identifier "$DB_CLUSTER_ID" --engine aurora-postgresql \
      --db-instance-class db.serverless --no-publicly-accessible >/dev/null
  fi

  log "Waiting for the database to become available..."
  aws rds wait db-instance-available --db-instance-identifier "$DB_INSTANCE_ID"
  DB_ENDPOINT=$(aws rds describe-db-clusters --db-cluster-identifier "$DB_CLUSTER_ID" \
    --query 'DBClusters[0].Endpoint' --output text)
}

# ------------------------------------------- secrets and environment vars ---
put_secret() { aws ssm put-parameter --name "$SSM_PREFIX/$1" --type SecureString --value "$2" --overwrite >/dev/null; }
add_env_item()    { ENV_ITEMS+=("{\"name\":\"$1\",\"value\":\"$(json_escape "$2")\"}"); }
add_secret_item() { SECRET_ITEMS+=("{\"name\":\"$1\",\"valueFrom\":\"arn:aws:ssm:$AWS_REGION:$ACCOUNT_ID:parameter$SSM_PREFIX/$1\"}"); }

step_config() {
  log "Storing secrets in SSM Parameter Store"
  local k v
  ENV_ITEMS=(); SECRET_ITEMS=()

  put_secret DATABASE_URL "postgres://$DB_USER:$DB_PASSWORD@$DB_ENDPOINT:5432/$DB_NAME"
  put_secret DB_PASSWORD "$DB_PASSWORD"
  add_secret_item DATABASE_URL
  add_secret_item DB_PASSWORD

  add_env_item DB_HOST "$DB_ENDPOINT"
  add_env_item DB_PORT 5432
  add_env_item DB_NAME "$DB_NAME"
  add_env_item DB_USER "$DB_USER"
  add_env_item DB_SSL true
  add_env_item PORT "$WEB_PORT"

  while IFS=$'\t' read -r k v; do add_env_item "$k" "$v"; done < <(read_kv_file "$ENV_FILE")
  while IFS=$'\t' read -r k v; do
    if [[ -z $v ]]; then continue; fi
    put_secret "$k" "$v"; add_secret_item "$k"
  done < <(read_kv_file "$SECRETS_FILE")

  ENV_JSON=$(join_by "${ENV_ITEMS[@]}")
  SECRETS_JSON=$(join_by "${SECRET_ITEMS[@]}")
}

# -------------------------------------------------------------------- IAM ---
step_iam() {
  log "IAM role for ECS task execution"
  aws iam create-service-linked-role --aws-service-name ecs.amazonaws.com >/dev/null 2>&1 || true
  aws iam create-service-linked-role --aws-service-name elasticloadbalancing.amazonaws.com >/dev/null 2>&1 || true
  if ! aws iam get-role --role-name "$EXEC_ROLE_NAME" >/dev/null 2>&1; then
    aws iam create-role --role-name "$EXEC_ROLE_NAME" --assume-role-policy-document \
      '{"Version":"2012-10-17","Statement":[{"Effect":"Allow","Principal":{"Service":"ecs-tasks.amazonaws.com"},"Action":"sts:AssumeRole"}]}' >/dev/null
    sleep 10
  fi
  aws iam attach-role-policy --role-name "$EXEC_ROLE_NAME" \
    --policy-arn arn:aws:iam::aws:policy/service-role/AmazonECSTaskExecutionRolePolicy
  aws iam put-role-policy --role-name "$EXEC_ROLE_NAME" --policy-name ssm-read --policy-document \
    "{\"Version\":\"2012-10-17\",\"Statement\":[{\"Effect\":\"Allow\",\"Action\":[\"ssm:GetParameters\",\"ssm:GetParameter\"],\"Resource\":\"arn:aws:ssm:$AWS_REGION:$ACCOUNT_ID:parameter$SSM_PREFIX/*\"}]}"
  EXEC_ROLE_ARN=$(aws iam get-role --role-name "$EXEC_ROLE_NAME" --query Role.Arn --output text)
}

# --------------------------------------------------------------- ALB / TG ---
has_listener() {
  local ports
  ports=$(aws elbv2 describe-listeners --load-balancer-arn "$ALB_ARN" --query 'Listeners[].Port' --output text)
  [[ " ${ports//$'\t'/ } " == *" $1 "* ]]
}

step_alb() {
  log "Application Load Balancer"
  ALB_ARN=$(aws elbv2 describe-load-balancers --names "$ALB_NAME" --query 'LoadBalancers[0].LoadBalancerArn' --output text 2>/dev/null || true)
  if [[ -z $ALB_ARN || $ALB_ARN == None ]]; then
    # shellcheck disable=SC2086
    ALB_ARN=$(aws elbv2 create-load-balancer --name "$ALB_NAME" --type application --scheme internet-facing \
      --subnets $SUBNET_IDS --security-groups "$ALB_SG" --query 'LoadBalancers[0].LoadBalancerArn' --output text)
  fi
  ALB_DNS=$(aws elbv2 describe-load-balancers --load-balancer-arns "$ALB_ARN" --query 'LoadBalancers[0].DNSName' --output text)

  TG_ARN=$(aws elbv2 describe-target-groups --names "$TG_NAME" --query 'TargetGroups[0].TargetGroupArn' --output text 2>/dev/null || true)
  if [[ -z $TG_ARN || $TG_ARN == None ]]; then
    TG_ARN=$(aws elbv2 create-target-group --name "$TG_NAME" --protocol HTTP --port "$WEB_PORT" \
      --vpc-id "$VPC_ID" --target-type ip --health-check-path "$HEALTH_PATH" \
      --health-check-interval-seconds 30 --healthy-threshold-count 2 \
      --query 'TargetGroups[0].TargetGroupArn' --output text)
    aws elbv2 modify-target-group-attributes --target-group-arn "$TG_ARN" \
      --attributes Key=deregistration_delay.timeout_seconds,Value=30 >/dev/null
  fi

  if ! has_listener 80; then
    if [[ -n $CERT_ARN ]]; then
      aws elbv2 create-listener --load-balancer-arn "$ALB_ARN" --protocol HTTP --port 80 \
        --default-actions 'Type=redirect,RedirectConfig={Protocol=HTTPS,Port=443,StatusCode=HTTP_301}' >/dev/null
    else
      aws elbv2 create-listener --load-balancer-arn "$ALB_ARN" --protocol HTTP --port 80 \
        --default-actions "Type=forward,TargetGroupArn=$TG_ARN" >/dev/null
    fi
  fi
  if [[ -n $CERT_ARN ]] && ! has_listener 443; then
    aws elbv2 create-listener --load-balancer-arn "$ALB_ARN" --protocol HTTPS --port 443 \
      --certificates "CertificateArn=$CERT_ARN" --ssl-policy ELBSecurityPolicy-TLS13-1-2-2021-06 \
      --default-actions "Type=forward,TargetGroupArn=$TG_ARN" >/dev/null
  fi
}

# ------------------------------------------------------------ ECS / tasks ---
container_json() {   # name image command_json port
  local name=$1 image=$2 cmd=$3 port=$4
  printf '{"name":"%s","image":"%s","essential":true,' "$name" "$image"
  if [[ -n $port ]]; then printf '"portMappings":[{"containerPort":%s,"protocol":"tcp"}],' "$port"; fi
  if [[ -n $cmd ]]; then printf '"command":%s,' "$cmd"; fi
  printf '"environment":[%s],"secrets":[%s],"stopTimeout":30,' "$ENV_JSON" "$SECRETS_JSON"
  printf '"logConfiguration":{"logDriver":"awslogs","options":{"awslogs-group":"%s","awslogs-region":"%s","awslogs-stream-prefix":"%s"}}}' \
    "$LOG_GROUP" "$AWS_REGION" "$name"
}

register_td() {   # family container image command port cpu memory
  local file="$WORKDIR/$1-taskdef.json"
  cat > "$file" <<EOF
{
  "family": "$1",
  "networkMode": "awsvpc",
  "requiresCompatibilities": ["FARGATE"],
  "cpu": "$6",
  "memory": "$7",
  "executionRoleArn": "$EXEC_ROLE_ARN",
  "runtimePlatform": {"cpuArchitecture": "X86_64", "operatingSystemFamily": "LINUX"},
  "containerDefinitions": [$(container_json "$2" "$3" "$4" "$5")]
}
EOF
  aws ecs register-task-definition --cli-input-json "file://$file" \
    --query 'taskDefinition.taskDefinitionArn' --output text
}

step_taskdefs() {
  log "Registering task definitions"
  aws logs create-log-group --log-group-name "$LOG_GROUP" 2>/dev/null || true
  aws logs put-retention-policy --log-group-name "$LOG_GROUP" --retention-in-days 14
  aws ecs create-cluster --cluster-name "$CLUSTER" >/dev/null
  WEB_TD=$(register_td "$APP_NAME-web" web "$WEB_IMAGE" "$WEB_COMMAND" "$WEB_PORT" "$WEB_CPU" "$WEB_MEMORY")
  WORKER_TD=$(register_td "$APP_NAME-worker" worker "$WORKER_IMAGE" "$WORKER_COMMAND" "" "$WORKER_CPU" "$WORKER_MEMORY")
}

step_migrate() {
  if [[ -z $MIGRATE_COMMAND ]]; then return 0; fi
  log "Running migrations: $MIGRATE_COMMAND"
  local arn code
  arn=$(aws ecs run-task --cluster "$CLUSTER" --launch-type FARGATE --task-definition "$WEB_TD" \
    --network-configuration "awsvpcConfiguration={subnets=[$SUBNET_CSV],securityGroups=[$APP_SG],assignPublicIp=ENABLED}" \
    --overrides "{\"containerOverrides\":[{\"name\":\"web\",\"command\":$MIGRATE_COMMAND}]}" \
    --query 'tasks[0].taskArn' --output text)
  [[ -n $arn && $arn != None ]] || die "Could not start the migration task."
  aws ecs wait tasks-stopped --cluster "$CLUSTER" --tasks "$arn"
  code=$(aws ecs describe-tasks --cluster "$CLUSTER" --tasks "$arn" --query 'tasks[0].containers[0].exitCode' --output text)
  [[ $code == 0 ]] || die "Migration failed (exit code $code). Logs: aws logs tail $LOG_GROUP --since 30m"
}

upsert_service() {   # name taskdef with_lb count
  local name=$1 td=$2 with_lb=$3 count=$4 exists
  local lb_args=()
  exists=$(aws ecs describe-services --cluster "$CLUSTER" --services "$name" \
    --query "services[?status=='ACTIVE'].serviceName" --output text)
  if [[ -n $exists ]]; then
    aws ecs update-service --cluster "$CLUSTER" --service "$name" --task-definition "$td" \
      --desired-count "$count" --force-new-deployment >/dev/null
  else
    if [[ $with_lb == true ]]; then
      lb_args=(--load-balancers "targetGroupArn=$TG_ARN,containerName=web,containerPort=$WEB_PORT"
               --health-check-grace-period-seconds 90)
    fi
    aws ecs create-service --cluster "$CLUSTER" --service-name "$name" --task-definition "$td" \
      --desired-count "$count" --launch-type FARGATE --platform-version LATEST \
      --network-configuration "awsvpcConfiguration={subnets=[$SUBNET_CSV],securityGroups=[$APP_SG],assignPublicIp=ENABLED}" \
      --deployment-configuration "deploymentCircuitBreaker={enable=true,rollback=true},maximumPercent=200,minimumHealthyPercent=100" \
      ${lb_args[@]+"${lb_args[@]}"} >/dev/null
  fi
}

step_services() {
  log "Deploying services"
  upsert_service "$APP_NAME-web" "$WEB_TD" true "$WEB_COUNT"
  upsert_service "$APP_NAME-worker" "$WORKER_TD" false "$WORKER_COUNT"
  log "Waiting for services to become stable (a few minutes)..."
  aws ecs wait services-stable --cluster "$CLUSTER" --services "$APP_NAME-web" "$APP_NAME-worker"
}

# ---------------------------------------------------------- status/destroy ---
step_status() {
  local dns
  dns=$(aws elbv2 describe-load-balancers --names "$ALB_NAME" --query 'LoadBalancers[0].DNSName' --output text 2>/dev/null || echo "-")
  echo "URL: http://$dns"
  aws ecs describe-services --cluster "$CLUSTER" --services "$APP_NAME-web" "$APP_NAME-worker" \
    --query 'services[].{service:serviceName,status:status,running:runningCount,desired:desiredCount}' --output table
}

step_destroy() {
  warn "This DELETES everything for '$APP_NAME' in $AWS_REGION: ECS, load balancer, Aurora database, ECR images, secrets."
  warn "Unless SKIP_FINAL_SNAPSHOT=true, a final database snapshot is kept (it incurs small storage cost)."
  local ans n fam td i
  read -r -p "Type the app name ($APP_NAME) to confirm: " ans
  [[ $ans == "$APP_NAME" ]] || die "Aborted."

  log "Removing ECS services and cluster"
  for n in web worker; do
    aws ecs update-service --cluster "$CLUSTER" --service "$APP_NAME-$n" --desired-count 0 >/dev/null 2>&1 || true
    aws ecs delete-service --cluster "$CLUSTER" --service "$APP_NAME-$n" --force >/dev/null 2>&1 || true
  done
  aws ecs wait services-inactive --cluster "$CLUSTER" --services "$APP_NAME-web" "$APP_NAME-worker" 2>/dev/null || true
  aws ecs delete-cluster --cluster "$CLUSTER" >/dev/null 2>&1 || true
  for fam in web worker; do
    for td in $(aws ecs list-task-definitions --family-prefix "$APP_NAME-$fam" --status ACTIVE --query 'taskDefinitionArns[]' --output text 2>/dev/null || true); do
      aws ecs deregister-task-definition --task-definition "$td" >/dev/null 2>&1 || true
    done
  done

  log "Removing load balancer"
  ALB_ARN=$(aws elbv2 describe-load-balancers --names "$ALB_NAME" --query 'LoadBalancers[0].LoadBalancerArn' --output text 2>/dev/null || true)
  if [[ -n $ALB_ARN && $ALB_ARN != None ]]; then
    aws elbv2 delete-load-balancer --load-balancer-arn "$ALB_ARN"
    aws elbv2 wait load-balancers-deleted --load-balancer-arns "$ALB_ARN" || true
  fi
  TG_ARN=$(aws elbv2 describe-target-groups --names "$TG_NAME" --query 'TargetGroups[0].TargetGroupArn' --output text 2>/dev/null || true)
  if [[ -n $TG_ARN && $TG_ARN != None ]]; then aws elbv2 delete-target-group --target-group-arn "$TG_ARN" || true; fi

  log "Removing Aurora database (takes several minutes)"
  if aws rds describe-db-clusters --db-cluster-identifier "$DB_CLUSTER_ID" >/dev/null 2>&1; then
    aws rds modify-db-cluster --db-cluster-identifier "$DB_CLUSTER_ID" --no-deletion-protection --apply-immediately >/dev/null
    aws rds delete-db-instance --db-instance-identifier "$DB_INSTANCE_ID" >/dev/null 2>&1 || true
    aws rds wait db-instance-deleted --db-instance-identifier "$DB_INSTANCE_ID" 2>/dev/null || true
    local snap
    if [[ ${SKIP_FINAL_SNAPSHOT:-false} == true ]]; then
      snap=(--skip-final-snapshot)
    else
      snap=(--no-skip-final-snapshot --final-db-snapshot-identifier "$DB_CLUSTER_ID-final-$(date +%Y%m%d%H%M%S)")
    fi
    aws rds delete-db-cluster --db-cluster-identifier "$DB_CLUSTER_ID" "${snap[@]}" >/dev/null
    while aws rds describe-db-clusters --db-cluster-identifier "$DB_CLUSTER_ID" >/dev/null 2>&1; do sleep 15; done
  fi
  aws rds delete-db-subnet-group --db-subnet-group-name "$DB_SUBNET_GROUP" >/dev/null 2>&1 || true

  log "Removing security groups, secrets, images, logs, IAM role"
  lookup_network
  for n in db app alb; do
    local sg; sg=$(find_sg "$APP_NAME-$n")
    if [[ -n $sg ]]; then
      for i in 1 2 3 4 5 6 7 8 9 10 11 12; do
        aws ec2 delete-security-group --group-id "$sg" >/dev/null 2>&1 && break
        sleep 10
      done
    fi
  done
  for n in $(aws ssm get-parameters-by-path --path "$SSM_PREFIX" --query 'Parameters[].Name' --output text 2>/dev/null || true); do
    aws ssm delete-parameter --name "$n" >/dev/null 2>&1 || true
  done
  for n in web worker; do aws ecr delete-repository --repository-name "$APP_NAME-$n" --force >/dev/null 2>&1 || true; done
  aws logs delete-log-group --log-group-name "$LOG_GROUP" >/dev/null 2>&1 || true
  aws iam detach-role-policy --role-name "$EXEC_ROLE_NAME" --policy-arn arn:aws:iam::aws:policy/service-role/AmazonECSTaskExecutionRolePolicy >/dev/null 2>&1 || true
  aws iam delete-role-policy --role-name "$EXEC_ROLE_NAME" --policy-name ssm-read >/dev/null 2>&1 || true
  aws iam delete-role --role-name "$EXEC_ROLE_NAME" >/dev/null 2>&1 || true
  log "Destroyed."
}

# ------------------------------------------------------------------- main ---
main() {
  case "${1:-deploy}" in
    deploy)
      preflight_aws; preflight_docker
      mkdir -p "$WORKDIR"
      TAG="${IMAGE_TAG:-$(date +%Y%m%d-%H%M%S)}"
      lookup_network
      step_network
      step_ecr
      step_build
      step_database
      step_config
      step_iam
      step_alb
      step_taskdefs
      step_migrate
      step_services
      echo
      log "Deployed. Open: http://$ALB_DNS"
      if [[ -z $CERT_ARN ]]; then warn "Serving plain HTTP. Set CERT_ARN in deploy/aws.config (ACM certificate) to enable HTTPS."; fi
      ;;
    status)  preflight_aws; step_status ;;
    destroy) preflight_aws; step_destroy ;;
    *) echo "Usage: $0 [deploy|status|destroy]"; exit 1 ;;
  esac
}

main "$@"
