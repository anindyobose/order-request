# AWS deployment preparation

## Audit report

- **Application:** Node.js 24, TypeScript, Next.js 16.4, React 19.3.
- **Database client:** Prisma 6.19 with PostgreSQL; Prisma reads `DATABASE_URL` from the schema.
- **Original process startup:** web started through the Dockerfile/Compose command after automatically applying migrations; the worker ran `npm run worker` from a Compose override. Compose now selects explicit `web` and `worker` targets and both start through their Dockerfile `CMD`.
- **Binding and health:** the web process now listens on `0.0.0.0` using `PORT` (default 3000). `/health` is a quick database-free liveness check; `/api/health` remains the database/worker readiness check.
- **Database setup:** application, worker, and migration command share URL construction. `DATABASE_URL` takes precedence, with `DB_HOST`, `DB_PORT`, `DB_NAME`, `DB_USER`, and `DB_PASSWORD` as fallback. `DB_SSL=true` requires verified TLS using the RDS global CA bundle; local Compose sets it to false.
- **Migrations:** a retrying `npm run migrate` command runs `prisma migrate deploy`. It is repeatable, runs once as the Compose `migrate` prerequisite locally, and is the one-off ECS task command during deploy.
- **Compose dependencies and volumes:** the original stack has a PostgreSQL 18 service, a persistent database volume, and a persistent product-upload volume. App startup now depends on migration completion rather than racing migrations in both containers. Web, worker, and migration services still wait for a healthy local database.
- **Environment variables read by the app/scripts:** database settings (`DATABASE_URL`, `DB_HOST`, `DB_PORT`, `DB_NAME`, `DB_USER`, `DB_PASSWORD`, `DB_SSL`); runtime (`PORT`, `NODE_ENV`); app/security (`APP_ORIGIN`, `APP_ENCRYPTION_KEY`); notification delivery (`ADMIN_NOTIFICATION_EMAILS`, `SMTP_HOST`, `SMTP_PORT`, `SMTP_SECURE`, `SMTP_USER`, `SMTP_PASSWORD`, `SMTP_FROM`, `SMS_PROVIDER_URL`, `SMS_PROVIDER_TOKEN`); initial-admin seeding (`ADMIN_EMAIL`, `ADMIN_PASSWORD`, `ADMIN_NAME`); and backup/restore tools (`NCM_BACKUP_DIRECTORY`, `NCM_OFFSITE_BACKUP_DIRECTORY`, `NCM_RESTORE_FILE`, `RESTORE_TEST_DATABASE_URL`). PostgreSQL bootstrap additionally uses `POSTGRES_DB`, `POSTGRES_USER`, and `POSTGRES_PASSWORD`. The deployment script supplies the DB and port variables directly; the AWS example env files intentionally do not duplicate those values.
- **Deployment script:** `deploy/deploy-aws.sh` is copied byte-for-byte from the supplied script. It builds the two Compose targets for `linux/amd64`, pushes to ECR, runs the migration task, and updates Fargate services. It has not been run and no AWS APIs were called.

## Before deploying

1. Install Docker Desktop with Compose v2, AWS CLI v2, and Git Bash or WSL. Authenticate to the intended AWS account and verify the selected region has a default VPC with public subnets in at least two availability zones. The deployment script provisions billable AWS resources.
2. Review `deploy/aws.config`. Its database settings match the local Compose database (`new_chandan_musicals`, PostgreSQL 18). Change `AWS_REGION` to your intended region. For production HTTPS, put an existing ACM certificate ARN for your domain into `CERT_ARN`; the certificate must be in that same region.
3. Copy the environment examples:

   ```powershell
   Copy-Item deploy/aws.env.example deploy/aws.env
   Copy-Item deploy/aws.secrets.env.example deploy/aws.secrets.env
   ```

   Edit `deploy/aws.env` with the real public HTTPS origin, email sender/SMTP host, and optional SMS provider URL. Replace secret placeholders in `deploy/aws.secrets.env`; generate the encryption key with:

   ```powershell
   node -e "console.log(require('node:crypto').randomBytes(32).toString('base64url'))"
   ```

   Keep the encryption key unchanged after launch: it is needed to decrypt queued password-reset payloads. Both actual env files are ignored by Git and Docker; the deployment script stores secret values in SSM Parameter Store.
4. Ensure the local `.env` used by Compose exists and has the PostgreSQL bootstrap values. Compose needs those values while it resolves its build configuration; `.env` is excluded from the image build context. The checked-in AWS config sets Aurora's initial database name to the local `POSTGRES_DB`.
5. Set up a domain DNS record pointing to the load balancer after the first deploy. The script creates the ALB and prints its DNS name; it does not create your domain's DNS record. Configure `APP_ORIGIN` to that domain and `CERT_ARN` before deployment so the ALB can use HTTPS. Do not send real customer traffic over the script's default plain-HTTP listener.

## Deploy

From the repository root in Git Bash or WSL, run:

```bash
bash deploy/deploy-aws.sh
```

This command creates or updates resources in the selected AWS account and can incur charges. It builds the standalone web and worker images as `linux/amd64`, creates the Aurora PostgreSQL cluster, applies migrations once, and deploys ECS services. It is intentionally not run as part of this preparation.

Check service status and the URL with:

```bash
bash deploy/deploy-aws.sh status
```

The first administrator is not seeded automatically. Before opening the storefront to users, run `npm run db:seed` in a one-off ECS task using the deployed web task definition and provide `ADMIN_EMAIL`, `ADMIN_NAME`, and a unique `ADMIN_PASSWORD` as temporary task overrides. Do not add the administrator password to either app environment file. Configure outbound email separately if password recovery and order notifications must be delivered.

## Local Compose verification

`docker compose up --build` starts PostgreSQL, applies migrations once through the `migrate` service, then starts web and worker. The ALB endpoint is database-independent, so a paused Aurora connection does not fail `/health`; `/api/health` remains available for database and worker diagnostics.

ECS task filesystems are ephemeral. The current product-upload feature writes beneath `public/uploads`; configure durable shared/object storage before scaling beyond a single web task or relying on uploaded media across replacements. Database backups also need an independent production backup plan.
