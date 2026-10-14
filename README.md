# New Chandan Musicals

A request-to-order storefront for New Chandan Musicals. The Node.js/Next.js application uses PostgreSQL as its source of truth, Prisma for persistence, and a GraphQL API for catalog, account, order, and shop operations. A request is not a payment: staff confirm final terms and verify any manually recorded payments before dispatch.

## Requirements

- Node.js 20.9 or newer and npm
- PostgreSQL 15 or newer
- `pg_dump` and `pg_restore` from a PostgreSQL client installation for backup and restore checks

Docker Compose is also supported for running the web app, database, and notification worker together. Its PostgreSQL service is published at `localhost:5433` to avoid colliding with a PostgreSQL server already using the standard `localhost:5432` port.

## Local setup

1. Create a local environment file and set a PostgreSQL database URL:

   ```powershell
   Copy-Item .env.example .env
   ```

   Set `DATABASE_URL` to a database and user you control, for example:

   ```text
   postgresql://ncm:YOUR_URL_ENCODED_PASSWORD@127.0.0.1:5432/new_chandan_musicals?schema=public
   ```

   Set a public `APP_ORIGIN` (for local development, `http://localhost:3000`) and generate a distinct 32-byte-or-longer `APP_ENCRYPTION_KEY`. For example, generate one with Node:

   ```powershell
   node -e "console.log(require('node:crypto').randomBytes(32).toString('base64url'))"
   ```

   Keep `.env` private and out of source control. The encryption key protects queued password-recovery notification data. Changing it makes already queued encrypted payloads unreadable.

2. Install dependencies, generate the Prisma client, apply the checked-in migration, and bootstrap the first administrator plus starter catalog:

   ```powershell
   npm install
   npm run db:generate
   npm run db:deploy
   npm run db:seed
   ```

   Before seeding, set `ADMIN_EMAIL`, `ADMIN_NAME`, and a unique `ADMIN_PASSWORD` of at least 12 characters containing uppercase, lowercase, and numeric characters. The seed command will not change an existing account's password or elevate a non-admin account.

3. Start the site and notification worker in separate terminals:

   ```powershell
   npm run dev
   ```

   ```powershell
   npm run worker
   ```

   Visit [http://localhost:3000](http://localhost:3000). Staff sign in at `/login`; administrators manage orders at `/admin`, products at `/admin/products`, user access at `/admin/users`, and notification settings at `/admin/settings`.

For schema development, edit `prisma/schema.prisma`, create a migration with `npm run db:migrate`, and commit the generated migration. Deployments should use `npm run db:deploy`, not `migrate dev`.

## Docker Compose

Copy `.env.example` to `.env`, set strong database/admin/encryption values, and use the Compose-internal host name `db` in `DATABASE_URL` (for example, `postgresql://ncm:URL_ENCODED_PASSWORD@db:5432/new_chandan_musicals?schema=public`). Then:

```powershell
docker compose up --build -d
docker compose run --rm web npm run db:seed
```

The `web` container deploys migrations before starting Next.js. The separate `worker` container processes notification jobs. PostgreSQL data and uploaded product images use named volumes. Back up volumes and the database independently; for multi-instance production hosting, configure durable shared/object storage for uploads instead of relying on a container-local filesystem.

## Accounts, notifications, and operations

- Registration creates buyer accounts. Administrators can grant admin access or revoke it from `/admin/users`; revoking leaves the user as an order operator. The API blocks self-demotion and prevents revoking the last administrator.
- Sessions use opaque HttpOnly cookies, password hashes use bcrypt, and recovery tokens are single-use and time-limited. Configure a real SMTP relay (`SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASSWORD`, `SMTP_FROM`) to deliver account recovery and order email. Without SMTP, jobs remain visible and are retried or marked failed; recovery mail is not shown in the browser.
- SMS is optional. Configure an approved `SMS_PROVIDER_URL` and `SMS_PROVIDER_TOKEN`, and ensure local consent, sender registration, and provider terms are satisfied before enabling it.
- `/api/health` reports database and notification-worker health. The admin settings page shows the same readiness, administrator new-order emails, optional dispatch SMS, failed-job retry controls, and health checks. Buyer status-update emails are queued for every order status change and are not disabled by event preferences; delivery requires a configured email provider and worker.
- Product image uploads accept JPEG, PNG, or WebP, up to 5 MB each. Uploaded files are written beneath `public/uploads`; protect that storage with durable backups and access controls.
- Administrators can bulk-import `.xlsx` workbooks or UTF-8 `.csv` files from `/admin/products`. Use the downloadable template: rows are matched by SKU, new SKUs are added, and existing SKUs have their catalog fields updated. Prices are whole rupees; use `FIXED`/`QUOTE`, `IN_STOCK`/`LIMITED`/`OUT_OF_STOCK`, and true/false (or yes/no, 1/0) for the corresponding fields. To import a product picture, embed one JPEG or PNG in that product's row in the Excel template's `image` column; it replaces the primary image while retaining the rest of the gallery. CSV cannot contain embedded pictures. Files are limited to 1,000 products and 5 MB, validated as a whole, and applied atomically; rows without a new picture preserve existing images and archive status.
- The staff request dashboard checks for new customer requests every 10 seconds and shows a dismissible notification with a shortcut to the new request. Polling failures are announced in the dashboard and retried automatically.
- Every order status transition is recorded in the audit history with its actor; staff and buyer messages are included with the author. A buyer email notification is queued in the same transaction for each transition.
- The starter catalog uses externally hosted sample photography. Replace it with shop-owned or properly licensed product images before production; product-management uploads are stored locally.
- Order operations are role-checked and audited. Sending final terms moves the order to “Awaiting buyer confirmation.” The buyer can accept in My Requests, or staff can record payment details (amount, method, and optional transaction ID) to advance it to “Awaiting payment”; staff payment entry does not record buyer acceptance or verify funds. Payment records must be separately verified by staff, and full verification is required before the order can be readied for dispatch.

## Backup and restore verification

Set `NCM_BACKUP_DIRECTORY` and `NCM_OFFSITE_BACKUP_DIRECTORY` to different protected locations, then run:

```powershell
npm run db:backup
```

The script writes a custom-format PostgreSQL dump and SHA-256 checksum locally, then copies both to the separately configured offsite path. It requires `pg_dump` on `PATH`.

To verify a specific dump without restoring over a production database, set `NCM_RESTORE_FILE` to the exact `.dump` path and `RESTORE_TEST_DATABASE_URL` to a dedicated empty database whose name ends in `_restore_test`, then run:

```powershell
npm run db:restore-test
```

This destructive restore command is restricted to that explicit test-database suffix. Run and document restore checks periodically and before production releases.

## Checks

```powershell
npm test
npm run lint
npx tsc --noEmit
npm run build
```

The repository includes unit tests for order transitions and input validation. Database integration, outbound provider delivery, and real backup/restore checks require separately configured PostgreSQL/provider services; a successful build alone does not verify those external integrations.
