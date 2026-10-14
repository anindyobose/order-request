import { existsSync } from "node:fs";

export const RDS_CA_FILE = "/etc/ssl/certs/rds-global-bundle.pem";

export function createDatabaseUrl(environment = process.env) {
  let connectionString = environment.DATABASE_URL?.trim();

  if (!connectionString) {
    const { DB_HOST, DB_PORT, DB_NAME, DB_USER, DB_PASSWORD } = environment;
    if (![DB_HOST, DB_PORT, DB_NAME, DB_USER, DB_PASSWORD].every(Boolean)) {
      throw new Error(
        "Set DATABASE_URL or all of DB_HOST, DB_PORT, DB_NAME, DB_USER, and DB_PASSWORD.",
      );
    }
    connectionString = `postgresql://${encodeURIComponent(DB_USER)}:${encodeURIComponent(DB_PASSWORD)}@${DB_HOST}:${DB_PORT}/${encodeURIComponent(DB_NAME)}`;
  }

  let databaseUrl;
  try {
    databaseUrl = new URL(connectionString);
  } catch {
    throw new Error("The configured database connection string is invalid.");
  }

  if (!["postgres:", "postgresql:"].includes(databaseUrl.protocol)) {
    throw new Error("The configured database connection string must use PostgreSQL.");
  }

  databaseUrl.searchParams.set("connect_timeout", "30");
  databaseUrl.searchParams.set("pool_timeout", "30");
  databaseUrl.searchParams.set("connection_limit", "10");
  databaseUrl.searchParams.set("max_lifetime", "300");

  const ssl = (environment.DB_SSL ?? "false").toLowerCase();
  if (!["true", "false"].includes(ssl)) {
    throw new Error("DB_SSL must be either true or false.");
  }
  if (ssl === "true") {
    if (!existsSync(RDS_CA_FILE)) {
      throw new Error(`DB_SSL=true requires the RDS CA bundle at ${RDS_CA_FILE}.`);
    }
    databaseUrl.searchParams.set("sslmode", "verify-full");
    databaseUrl.searchParams.set("sslrootcert", RDS_CA_FILE);
  } else {
    databaseUrl.searchParams.delete("sslmode");
    databaseUrl.searchParams.delete("sslrootcert");
  }

  return databaseUrl.toString();
}

export async function connectWithRetry(connect, { maxWaitMs = 60_000, onRetry } = {}) {
  const deadline = Date.now() + maxWaitMs;
  let attempt = 0;
  let delayMs = 1000;

  while (true) {
    try {
      await connect();
      return;
    } catch {
      attempt += 1;
      const remainingMs = deadline - Date.now();
      if (remainingMs <= 0) {
        throw new Error(`Database connection failed after approximately ${Math.ceil(maxWaitMs / 1000)} seconds of retries.`);
      }

      const waitMs = Math.min(delayMs, remainingMs);
      onRetry?.(attempt, waitMs);
      await new Promise((resolve) => setTimeout(resolve, waitMs));
      delayMs = Math.min(delayMs * 2, 10_000);
    }
  }
}
