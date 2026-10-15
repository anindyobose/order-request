# Google Cloud deployment preparation

## Audit report

- **Application:** Node.js 24, TypeScript, Next.js 16.4, React 19.3.
- **Database:** Prisma 6 with PostgreSQL. The app uses a Prisma singleton per process; each process now caps its pool at `DB_POOL_MAX` (default 5, maximum 5).
- **Startup:** Dockerfile has separate direct Node `CMD`s for web and worker. The web binds to `0.0.0.0:$PORT` (default 3000). The worker has no HTTP listener or exposed port.
- **Database config:** `DB_*` variables are preferred. A `DB_HOST` starting with `/` is encoded as Prisma's PostgreSQL `host=/cloudsql/...` Unix-socket parameter; TCP remains available for local Compose. TLS is disabled because Cloud SQL's connector handles encryption. Startup and migrations retry for up to about 30 seconds.
- **Migrations:** `npm run migrate` runs repeatable `prisma migrate deploy`. Compose uses a one-shot migration dependency; Cloud Run deployment invokes the migration as a job before services are updated.
- **State:** auth sessions, password resets, rate limits, orders, and notification jobs are in PostgreSQL. The shopping cart is held in browser `localStorage`, not server memory. The Prisma singleton and worker SMTP transport are process-local connection/client caches, not application state.
- **Statelessness fix:** uploads used to write to `public/uploads`, which is not durable or shared on Cloud Run. New manual and Excel-import uploads now store image bytes in PostgreSQL and use `/uploads/<uuid>.<ext>` to read them. Legacy local files can still be served from the Compose volume. Existing database image records that only point to old local files do not contain their old image bytes; re-upload those images after migrating to Cloud SQL.
- **Response lifecycle:** HTTP handlers await their database/provider work before returning. Notification jobs are enqueued transactionally in PostgreSQL before the response; no handler schedules work to run after responding.
- **Compose:** local PostgreSQL data and legacy product image files use named volumes; there are no source bind mounts. Web and worker wait for the one-shot migration service, which waits for healthy PostgreSQL.
- **Environment variables:** DB/runtime (`DATABASE_URL`, `DB_HOST`, `DB_PORT`, `DB_NAME`, `DB_USER`, `DB_PASSWORD`, `DB_SSL`, `DB_POOL_MAX`, `PORT`, `NODE_ENV`); app/security/notifications (`APP_ORIGIN`, `APP_ENCRYPTION_KEY`, `ADMIN_NOTIFICATION_EMAILS`, `SMTP_HOST`, `SMTP_PORT`, `SMTP_SECURE`, `SMTP_USER`, `SMTP_PASSWORD`, `SMTP_FROM`, `SMS_PROVIDER_URL`, `SMS_PROVIDER_TOKEN`); seed (`ADMIN_EMAIL`, `ADMIN_PASSWORD`, `ADMIN_NAME`); backup/restore tools (`NCM_BACKUP_DIRECTORY`, `NCM_OFFSITE_BACKUP_DIRECTORY`, `NCM_RESTORE_FILE`, `RESTORE_TEST_DATABASE_URL`); Compose DB bootstrap (`POSTGRES_DB`, `POSTGRES_USER`, `POSTGRES_PASSWORD`). `INSTANCE_CONNECTION_NAME` is injected by the GCP script but is not read directly by app code.
- **Deployment script:** the supplied `deploy/deploy-gcp.sh` is copied unchanged. It builds/pushes `linux/amd64` images, runs a migration job, deploys Cloud Run web and worker-pool workloads, and runs a smoke check. It has not been run.

## Before deployment

1. Create a Google Cloud project in the Cloud Console and attach a billing account. Create a budget alert, enable MFA on your Google account, and avoid service-account keys. The deployment script creates billable Cloud Run, Cloud SQL, Artifact Registry, Secret Manager, and related resources.
2. Install Google Cloud CLI, Docker Desktop with Compose v2, and Git Bash or WSL. Authenticate and select the project:

   ```powershell
   gcloud auth login
   gcloud config set project YOUR_PROJECT_ID
   gcloud config get-value project
   gcloud auth list
   docker info
   docker compose version
   bash --version
   ```

   Use the actual project ID, not its display name. Set the same value as `PROJECT_ID` in `deploy/gcp.config`.
3. Review `deploy/gcp.config`. Keep `REGION=asia-south1` only if the Cloud Run worker-pool feature is available there for your account; the script requires it. It sets the local database name to `new_chandan_musicals`, PostgreSQL 18, web port 3000, and the `npm run migrate` command.
4. Create the ignored local configuration files:

   ```powershell
   Copy-Item deploy/gcp.env.example deploy/gcp.env
   Copy-Item deploy/gcp.secrets.env.example deploy/gcp.secrets.env
   ```

   Set `APP_ORIGIN` to the intended Cloud Run URL (update after deployment if needed), configure SMTP only if you have valid provider details, and replace secret placeholders. Generate the encryption key with:

   ```powershell
   node -e "console.log(require('node:crypto').randomBytes(32).toString('base64url'))"
   ```

   Keep `APP_ENCRYPTION_KEY` stable. Do not put `DB_*`, `DATABASE_URL`, `INSTANCE_CONNECTION_NAME`, or `PORT` in these files; the script supplies DB settings and Cloud Run owns `PORT`. These files are ignored by Git and excluded from the image build.
5. Keep the repository `.env` available for local Compose interpolation and ensure it has PostgreSQL bootstrap values. The deployment script builds with Compose and needs these values to resolve its build configuration; `.env` is excluded from the Docker context.

## Provision and deploy

From the repository root in Git Bash or WSL:

```bash
bash deploy/deploy-gcp.sh
```

This command creates infrastructure and deploys the app; it is not run during this preparation. The script enables required APIs, creates runtime identity/permissions, Artifact Registry, Cloud SQL, secrets, Cloud Run service and worker pool, runs the one-off migration job, and smoke-tests web. Confirm the project ID, region, and costs before proceeding.

Check deployment status with:

```bash
bash deploy/deploy-gcp.sh status
```

The script does not migrate local PostgreSQL data. Prisma migrations create/upgrade schema only. If retaining local users, products, or orders is required, plan a separate data migration before inviting customers.

The first admin is not seeded automatically. After Cloud SQL is deployed and migrations finish, run `node scripts/seed-admin.mjs` as a one-off Cloud Run job using the same service identity and Cloud SQL attachment, with temporary `ADMIN_EMAIL`, `ADMIN_NAME`, and `ADMIN_PASSWORD` overrides. Do not store the admin password in committed config or persistent app env files. Verify admin login, image upload/read, and notification delivery before going live.

## Operational notes

- Cloud SQL has a connection limit. Each web instance and worker process uses at most five Prisma connections; lower `DB_POOL_MAX` if the SQL tier or service scaling requires it. The deployment script caps web scaling at two instances by default.
- The notification worker reads durable jobs from PostgreSQL. Shutdown stops claiming new work, waits for current work, then disconnects. Interrupted jobs are returned to retry after the stale-claim timeout; email/SMS delivery is at-least-once and can repeat if a process is killed after external delivery but before recording success.
- Product image bytes share Cloud SQL persistence across instances. Account for their database growth and include them in backups. The local `public/uploads` fallback exists only for legacy Compose files.
- `/health` returns without connecting to Cloud SQL, so a cold database does not fail the platform health check. `/api/health` remains the DB/worker diagnostic endpoint.
- Review the generated Cloud Run URL and authentication requirements before going live. The deployment script defaults `ALLOW_PUBLIC=true`.
