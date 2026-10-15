#!/usr/bin/env bash
#
# deploy-gcp.sh : deploy the "order-request" stack to Google Cloud with one command.
#
#   web     -> Cloud Run service (HTTPS URL included, scales to zero)
#   worker  -> Cloud Run worker pool (always-on, no HTTP)
#   db      -> Cloud SQL for PostgreSQL (small shared-core instance)
#   secrets -> Secret Manager, images -> Artifact Registry
#
# Usage (run from your project root, where docker-compose.yml lives):
#   ./deploy-gcp.sh            create or update everything (safe to re-run)
#   ./deploy-gcp.sh status     show URL and state
#   ./deploy-gcp.sh destroy    delete everything (asks for confirmation)
#
# The ONLY manual step is logging in first:
#   gcloud auth login
# and having a Google Cloud project with billing enabled (ask your admin, or set
# BILLING_ACCOUNT below and the script will create the project for you).
#
# Requirements: recent Google Cloud CLI (gcloud), Docker with compose v2, bash
# (use WSL or Git Bash on Windows). If "gcloud run worker-pools" is unknown, run:
#   gcloud components update
#
# Optional settings go in deploy/gcp.config (plain shell, KEY=value), for example:
#   PROJECT_ID=my-company-order-request
#   REGION=asia-south1                  # worker pools must be available in your region
#   APP_NAME=order-request              # lowercase letters, digits, hyphens (max ~26 chars)
#   WEB_SERVICE=web
#   WORKER_SERVICE=worker
#   WEB_PORT=3000
#   HEALTH_PATH=/health
#   WEB_COMMAND=                        # space-separated, only if compose overrides the image CMD
#   WORKER_COMMAND="node worker.js"     # space-separated, only if compose overrides the image CMD
#   MIGRATE_COMMAND="npm run migrate"   # run once per deploy before services update
#   DB_NAME=appdb
#   DB_MAJOR=16                         # match your local postgres major version
#   SQL_TIER=db-g1-small                # db-f1-micro is cheaper (about $8/mo) but very small
#   ALLOW_PUBLIC=true                   # false = private service (use: gcloud run services proxy)
#   BILLING_ACCOUNT=XXXXXX-XXXXXX-XXXXXX   # only if the script should create the project
#   ORGANIZATION_ID=123456789              # only if creating the project inside an organization
#
# App configuration:
#   deploy/gcp.env           plain env vars   (KEY=value per line)
#   deploy/gcp.secrets.env   secrets          (KEY=value per line; stored in Secret Manager)
# DB_HOST, DB_PORT, DB_NAME, DB_USER, DB_PASSWORD, DB_SSL, DATABASE_URL and
# INSTANCE_CONNECTION_NAME are set for you. PORT is set by Cloud Run (do not add it).

set -Eeuo pipefail
trap 'echo "Failed at line $LINENO" >&2' ERR
export MSYS_NO_PATHCONV=1 CLOUDSDK_CORE_DISABLE_PROMPTS=1   # no Git Bash path mangling, no prompts

# ----------------------------------------------------------------- config ---
CONFIG_FILE="${CONFIG_FILE:-deploy/gcp.config}"
if [[ -f $CONFIG_FILE ]]; then
  # shellcheck disable=SC1090
  source "$CONFIG_FILE"
fi

APP_NAME="${APP_NAME:-order-request}"
PROJECT_ID="${PROJECT_ID:-}"
REGION="${REGION:-asia-south1}"
BILLING_ACCOUNT="${BILLING_ACCOUNT:-}"
ORGANIZATION_ID="${ORGANIZATION_ID:-}"

COMPOSE_FILE="${COMPOSE_FILE:-docker-compose.yml}"
WEB_SERVICE="${WEB_SERVICE:-web}"
WORKER_SERVICE="${WORKER_SERVICE:-worker}"
WEB_PORT="${WEB_PORT:-3000}"
HEALTH_PATH="${HEALTH_PATH:-/health}"
WEB_COMMAND="${WEB_COMMAND:-}"
WORKER_COMMAND="${WORKER_COMMAND:-}"
MIGRATE_COMMAND="${MIGRATE_COMMAND:-}"
ALLOW_PUBLIC="${ALLOW_PUBLIC:-true}"

WEB_CPU="${WEB_CPU:-1}";       WEB_MEMORY="${WEB_MEMORY:-512Mi}"
WEB_MIN="${WEB_MIN:-0}";       WEB_MAX="${WEB_MAX:-2}"        # keep max low: the small DB has few connections
WORKER_CPU="${WORKER_CPU:-1}"; WORKER_MEMORY="${WORKER_MEMORY:-512Mi}"   # worker pools: whole CPUs (1, 2, 4, 8)
WORKER_COUNT="${WORKER_COUNT:-1}"

DB_NAME="${DB_NAME:-appdb}"
DB_USER="${DB_USER:-appuser}"
DB_MAJOR="${DB_MAJOR:-16}"
SQL_TIER="${SQL_TIER:-db-g1-small}"
SQL_DISK_GB="${SQL_DISK_GB:-10}"
SQL_DELETION_PROTECTION="${SQL_DELETION_PROTECTION:-true}"

ENV_FILE="${ENV_FILE:-deploy/gcp.env}"
SECRETS_FILE="${SECRETS_FILE:-deploy/gcp.secrets.env}"
WORKDIR=".gcp-deploy"                          # add to .gitignore

SQL_INSTANCE="$APP_NAME-db"
SA_NAME="$APP_NAME-run"
JOB_NAME="$APP_NAME-migrate"

# ---------------------------------------------------------------- helpers ---
log()  { printf '\033[1;34m==>\033[0m %s\n' "$*" >&2; }
warn() { printf '\033[1;33m!!\033[0m  %s\n' "$*" >&2; }
die()  { printf '\033[1;31mERROR:\033[0m %s\n' "$*" >&2; exit 1; }
need() { command -v "$1" >/dev/null 2>&1 || die "'$1' is not installed or not on PATH"; }
json_escape() { local s=$1; s=${s//\\/\\\\}; s=${s//\"/\\\"}; printf '%s' "$s"; }
join_by() { local IFS=,; printf '%s' "$*"; }

retry() {   # retry N cmd... : IAM changes can take a few seconds to propagate
  local n=$1 i; shift
  for ((i = 1; i < n; i++)); do
    if "$@" >/dev/null 2>&1; then return 0; fi
    sleep 10
  done
  "$@" >/dev/null
}

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

cmd_flags() {   # "node worker.js" -> CMD_FLAGS=(--command=node --args=^|^worker.js)
  CMD_FLAGS=()
  local words=()
  read -r -a words <<<"${1:-}" || true
  if [[ ${#words[@]} -gt 0 ]]; then
    CMD_FLAGS+=("--command=${words[0]}")
    if [[ ${#words[@]} -gt 1 ]]; then
      local IFS='|'
      CMD_FLAGS+=("--args=^|^${words[*]:1}")
    fi
  fi
}

# -------------------------------------------------------------- preflight ---
preflight_gcloud() {
  need gcloud
  local account
  account=$(gcloud auth list --filter=status:ACTIVE --format='value(account)' 2>/dev/null || true)
  [[ -n $account ]] || die "Not logged in to Google Cloud. Run:  gcloud auth login"
  if [[ -z $PROJECT_ID ]]; then PROJECT_ID=$(gcloud config get-value project 2>/dev/null || true); fi
  if [[ -z $PROJECT_ID || $PROJECT_ID == "(unset)" ]]; then
    die "No project set. Add PROJECT_ID=... to deploy/gcp.config (or run: gcloud config set project <id>)."
  fi
  export CLOUDSDK_CORE_PROJECT="$PROJECT_ID"
  log "Google Cloud: $account, project $PROJECT_ID, region $REGION"

  if ! gcloud projects describe "$PROJECT_ID" >/dev/null 2>&1; then
    [[ -n $BILLING_ACCOUNT ]] || die "Project '$PROJECT_ID' not found (or no access). Create it, or set BILLING_ACCOUNT so I can create it."
    local org=()
    if [[ -n $ORGANIZATION_ID ]]; then org=(--organization="$ORGANIZATION_ID"); fi
    log "Creating project $PROJECT_ID"
    gcloud projects create "$PROJECT_ID" ${org[@]+"${org[@]}"}
    gcloud billing projects link "$PROJECT_ID" --billing-account="$BILLING_ACCOUNT"
  fi
  local billing
  billing=$(gcloud billing projects describe "$PROJECT_ID" --format='value(billingEnabled)' 2>/dev/null || true)
  if [[ $billing == False ]]; then die "Billing is not enabled on project $PROJECT_ID."; fi
}

preflight_docker() {
  need docker
  docker info >/dev/null 2>&1 || die "Docker is not running."
  docker compose version >/dev/null 2>&1 || die "Docker compose v2 is required."
  [[ -f $COMPOSE_FILE ]] || die "'$COMPOSE_FILE' not found. Run this script from your project root."
}

# ------------------------------------------------------- APIs and identity ---
step_apis() {
  log "Enabling Google Cloud APIs (first run can take a minute or two)"
  gcloud services enable run.googleapis.com sqladmin.googleapis.com artifactregistry.googleapis.com \
    secretmanager.googleapis.com iam.googleapis.com cloudresourcemanager.googleapis.com
}

step_identity() {
  SA_EMAIL="$SA_NAME@$PROJECT_ID.iam.gserviceaccount.com"
  if ! gcloud iam service-accounts describe "$SA_EMAIL" >/dev/null 2>&1; then
    log "Creating service account $SA_EMAIL"
    gcloud iam service-accounts create "$SA_NAME" --display-name="$APP_NAME runtime"
    sleep 15
  fi
  retry 5 gcloud projects add-iam-policy-binding "$PROJECT_ID" \
    --member="serviceAccount:$SA_EMAIL" --role=roles/cloudsql.client --condition=None
}

# --------------------------------------------------------- images / build ---
step_registry() {
  REGISTRY="$REGION-docker.pkg.dev/$PROJECT_ID/$APP_NAME"
  WEB_IMAGE="$REGISTRY/web:$TAG"
  WORKER_IMAGE="$REGISTRY/worker:$TAG"
  if ! gcloud artifacts repositories describe "$APP_NAME" --location="$REGION" >/dev/null 2>&1; then
    log "Creating Artifact Registry repository $APP_NAME"
    gcloud artifacts repositories create "$APP_NAME" --repository-format=docker \
      --location="$REGION" --description="$APP_NAME images" >/dev/null
  fi
}

step_build() {
  log "Building and pushing images (tag $TAG, linux/amd64)"
  gcloud auth print-access-token | docker login -u oauth2accesstoken --password-stdin "https://$REGION-docker.pkg.dev" >/dev/null
  cat > "$WORKDIR/compose.gcp.yml" <<EOF
services:
  $WEB_SERVICE:
    image: $WEB_IMAGE
    platform: linux/amd64
  $WORKER_SERVICE:
    image: $WORKER_IMAGE
    platform: linux/amd64
EOF
  docker compose -f "$COMPOSE_FILE" -f "$WORKDIR/compose.gcp.yml" build "$WEB_SERVICE" "$WORKER_SERVICE"
  docker compose -f "$COMPOSE_FILE" -f "$WORKDIR/compose.gcp.yml" push "$WEB_SERVICE" "$WORKER_SERVICE"
}

# ---------------------------------------------------------------- secrets ---
put_secret() {   # KEY VALUE -> secret "<app>-<KEY>", readable by the runtime service account
  local id="$APP_NAME-$1" current
  if ! gcloud secrets describe "$id" >/dev/null 2>&1; then
    gcloud secrets create "$id" --replication-policy=user-managed --locations="$REGION" >/dev/null
  fi
  current=$(gcloud secrets versions access latest --secret="$id" 2>/dev/null || true)
  if [[ $current != "$2" ]]; then
    printf '%s' "$2" | gcloud secrets versions add "$id" --data-file=- >/dev/null
  fi
  retry 5 gcloud secrets add-iam-policy-binding "$id" \
    --member="serviceAccount:$SA_EMAIL" --role=roles/secretmanager.secretAccessor
}

# --------------------------------------------------------------- database ---
step_database() {
  log "Database: Cloud SQL for PostgreSQL ($SQL_TIER)"
  DB_PASSWORD=$(gcloud secrets versions access latest --secret="$APP_NAME-DB_PASSWORD" 2>/dev/null || true)
  if [[ -z $DB_PASSWORD ]]; then
    DB_PASSWORD=$(openssl rand -hex 20 2>/dev/null || python3 -c 'import secrets;print(secrets.token_hex(20))')
  fi
  put_secret DB_PASSWORD "$DB_PASSWORD"

  if ! gcloud sql instances describe "$SQL_INSTANCE" >/dev/null 2>&1; then
    local protect=--no-deletion-protection
    if [[ $SQL_DELETION_PROTECTION == true ]]; then protect=--deletion-protection; fi
    log "Creating Cloud SQL instance. This takes about 5-10 minutes."
    gcloud sql instances create "$SQL_INSTANCE" \
      --database-version="POSTGRES_$DB_MAJOR" --edition=ENTERPRISE --tier="$SQL_TIER" --region="$REGION" \
      --storage-type=SSD --storage-size="$SQL_DISK_GB" --storage-auto-increase \
      --availability-type=zonal --backup-start-time=21:00 --enable-point-in-time-recovery \
      --ssl-mode=ENCRYPTED_ONLY "$protect"
  fi

  if ! gcloud sql databases describe "$DB_NAME" --instance="$SQL_INSTANCE" >/dev/null 2>&1; then
    gcloud sql databases create "$DB_NAME" --instance="$SQL_INSTANCE" >/dev/null
  fi
  if [[ -n $(gcloud sql users list --instance="$SQL_INSTANCE" --filter="name=$DB_USER" --format='value(name)') ]]; then
    gcloud sql users set-password "$DB_USER" --instance="$SQL_INSTANCE" --password="$DB_PASSWORD" >/dev/null
  else
    gcloud sql users create "$DB_USER" --instance="$SQL_INSTANCE" --password="$DB_PASSWORD" >/dev/null
  fi
  CONN=$(gcloud sql instances describe "$SQL_INSTANCE" --format='value(connectionName)')
}

# ------------------------------------------------ env vars and secret refs ---
yaml_kv() { printf '%s: "%s"\n' "$1" "$(json_escape "$2")"; }

step_config() {
  log "Writing configuration and secrets"
  local k v pairs=()
  {
    yaml_kv DB_HOST "/cloudsql/$CONN"
    yaml_kv DB_PORT 5432
    yaml_kv DB_NAME "$DB_NAME"
    yaml_kv DB_USER "$DB_USER"
    yaml_kv DB_SSL false
    yaml_kv INSTANCE_CONNECTION_NAME "$CONN"
    while IFS=$'\t' read -r k v; do yaml_kv "$k" "$v"; done < <(read_kv_file "$ENV_FILE")
  } > "$WORKDIR/env.yaml"

  put_secret DATABASE_URL "postgresql://$DB_USER:$DB_PASSWORD@/$DB_NAME?host=/cloudsql/$CONN"
  pairs+=("DB_PASSWORD=$APP_NAME-DB_PASSWORD:latest" "DATABASE_URL=$APP_NAME-DATABASE_URL:latest")
  while IFS=$'\t' read -r k v; do
    if [[ -z $v ]]; then continue; fi
    put_secret "$k" "$v"
    pairs+=("$k=$APP_NAME-$k:latest")
  done < <(read_kv_file "$SECRETS_FILE")
  SECRETS_ARG=$(join_by "${pairs[@]}")
}

# ------------------------------------------------------ migrations / deploy ---
step_migrate() {
  if [[ -z $MIGRATE_COMMAND ]]; then return 0; fi
  log "Running migrations: $MIGRATE_COMMAND"
  cmd_flags "$MIGRATE_COMMAND"
  gcloud run jobs deploy "$JOB_NAME" --image "$WEB_IMAGE" --region "$REGION" \
    --service-account "$SA_EMAIL" --set-cloudsql-instances "$CONN" \
    --env-vars-file "$WORKDIR/env.yaml" --set-secrets "$SECRETS_ARG" \
    --max-retries 0 --task-timeout 10m "${CMD_FLAGS[@]}" >/dev/null
  gcloud run jobs execute "$JOB_NAME" --region "$REGION" --wait \
    || die "Migration failed. Logs: gcloud run jobs logs read $JOB_NAME --region $REGION --limit 50"
}

step_deploy() {
  log "Deploying web (Cloud Run service)"
  cmd_flags "$WEB_COMMAND"
  gcloud run deploy "$APP_NAME-web" --image "$WEB_IMAGE" --region "$REGION" --port "$WEB_PORT" \
    --service-account "$SA_EMAIL" --cpu "$WEB_CPU" --memory "$WEB_MEMORY" \
    --min-instances "$WEB_MIN" --max-instances "$WEB_MAX" \
    --set-cloudsql-instances "$CONN" --env-vars-file "$WORKDIR/env.yaml" --set-secrets "$SECRETS_ARG" \
    ${CMD_FLAGS[@]+"${CMD_FLAGS[@]}"} >/dev/null

  if [[ $ALLOW_PUBLIC == true ]]; then
    if ! gcloud run services add-iam-policy-binding "$APP_NAME-web" --region "$REGION" \
        --member=allUsers --role=roles/run.invoker >/dev/null 2>&1; then
      warn "Could not make the service public (an organization policy may forbid it)."
      warn "Reach it privately with: gcloud run services proxy $APP_NAME-web --region $REGION"
      ALLOW_PUBLIC=false
    fi
  fi

  log "Deploying worker (Cloud Run worker pool)"
  cmd_flags "$WORKER_COMMAND"
  gcloud run worker-pools deploy "$APP_NAME-worker" --image "$WORKER_IMAGE" --region "$REGION" \
    --service-account "$SA_EMAIL" --instances "$WORKER_COUNT" --cpu "$WORKER_CPU" --memory "$WORKER_MEMORY" \
    --set-cloudsql-instances "$CONN" --env-vars-file "$WORKDIR/env.yaml" --set-secrets "$SECRETS_ARG" \
    ${CMD_FLAGS[@]+"${CMD_FLAGS[@]}"} >/dev/null

  WEB_URL=$(gcloud run services describe "$APP_NAME-web" --region "$REGION" --format='value(status.url)')
}

smoke_test() {
  if [[ $ALLOW_PUBLIC == true ]] && command -v curl >/dev/null 2>&1; then
    log "Smoke test: $WEB_URL$HEALTH_PATH"
    if curl -fsS -m 60 -o /dev/null "$WEB_URL$HEALTH_PATH"; then
      log "Health check OK"
    else
      warn "Health check failed. Logs: gcloud run services logs read $APP_NAME-web --region $REGION --limit 50"
    fi
  fi
}

# ---------------------------------------------------------- status/destroy ---
step_status() {
  echo "URL:  $(gcloud run services describe "$APP_NAME-web" --region "$REGION" --format='value(status.url)' 2>/dev/null || echo '-')"
  echo "DB:   $(gcloud sql instances describe "$SQL_INSTANCE" --format='value(state)' 2>/dev/null || echo '-')"
  gcloud run services list --region "$REGION" --filter="metadata.name=$APP_NAME-web" 2>/dev/null || true
  gcloud run worker-pools list --region "$REGION" --filter="metadata.name=$APP_NAME-worker" 2>/dev/null || true
}

step_destroy() {
  warn "This DELETES everything for '$APP_NAME' in project $PROJECT_ID: Cloud Run, the Cloud SQL database and ALL its data,"
  warn "images and secrets. Export your data first if you need it. The Cloud SQL instance name may be unusable for a while."
  local ans n
  read -r -p "Type the app name ($APP_NAME) to confirm: " ans
  [[ $ans == "$APP_NAME" ]] || die "Aborted."

  log "Removing Cloud Run resources"
  gcloud run services delete "$APP_NAME-web" --region "$REGION" >/dev/null 2>&1 || true
  gcloud run worker-pools delete "$APP_NAME-worker" --region "$REGION" >/dev/null 2>&1 || true
  gcloud run jobs delete "$JOB_NAME" --region "$REGION" >/dev/null 2>&1 || true

  log "Removing Cloud SQL instance (takes a few minutes)"
  if gcloud sql instances describe "$SQL_INSTANCE" >/dev/null 2>&1; then
    gcloud sql instances patch "$SQL_INSTANCE" --no-deletion-protection >/dev/null
    gcloud sql instances delete "$SQL_INSTANCE" >/dev/null
  fi

  log "Removing secrets, images and service account"
  for n in $(gcloud secrets list --format='value(name)' 2>/dev/null | grep "/secrets/$APP_NAME-" || true); do
    gcloud secrets delete "${n##*/}" >/dev/null 2>&1 || true
  done
  gcloud artifacts repositories delete "$APP_NAME" --location="$REGION" >/dev/null 2>&1 || true
  SA_EMAIL="$SA_NAME@$PROJECT_ID.iam.gserviceaccount.com"
  gcloud projects remove-iam-policy-binding "$PROJECT_ID" --member="serviceAccount:$SA_EMAIL" \
    --role=roles/cloudsql.client --condition=None >/dev/null 2>&1 || true
  gcloud iam service-accounts delete "$SA_EMAIL" >/dev/null 2>&1 || true
  log "Destroyed. (APIs stay enabled; that costs nothing.)"
}

# ------------------------------------------------------------------- main ---
main() {
  case "${1:-deploy}" in
    deploy)
      preflight_gcloud; preflight_docker
      mkdir -p "$WORKDIR"
      TAG="${IMAGE_TAG:-$(date +%Y%m%d-%H%M%S)}"
      step_apis
      step_identity
      step_registry
      step_build
      step_database
      step_config
      step_migrate
      step_deploy
      smoke_test
      echo
      log "Deployed. Open: $WEB_URL"
      ;;
    status)  preflight_gcloud; step_status ;;
    destroy) preflight_gcloud; step_destroy ;;
    *) echo "Usage: $0 [deploy|status|destroy]"; exit 1 ;;
  esac
}

main "$@"
