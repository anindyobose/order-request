export function createDatabaseUrl(environment = process.env) {
  const configuredPoolMax = Number(environment.DB_POOL_MAX ?? 5);
  if (!Number.isInteger(configuredPoolMax) || configuredPoolMax < 1 || configuredPoolMax > 5) {
    throw new Error("DB_POOL_MAX must be a whole number between 1 and 5.");
  }

  const ssl = (environment.DB_SSL ?? "false").toLowerCase();
  if (!["true", "false"].includes(ssl)) {
    throw new Error("DB_SSL must be either true or false.");
  }

  const { DB_HOST, DB_PORT, DB_NAME, DB_USER, DB_PASSWORD } = environment;
  const hasDatabaseVariables = [DB_HOST, DB_NAME, DB_USER, DB_PASSWORD].every(Boolean);
  const isUnixSocket = Boolean(DB_HOST?.startsWith("/"));
  let databaseUrl;

  if (hasDatabaseVariables) {
    const authorityHost = isUnixSocket ? "localhost" : DB_HOST;
    const port = isUnixSocket ? "" : `:${DB_PORT || "5432"}`;
    databaseUrl = new URL(
      `postgresql://${encodeURIComponent(DB_USER)}:${encodeURIComponent(DB_PASSWORD)}@${authorityHost}${port}/${encodeURIComponent(DB_NAME)}`,
    );
    if (isUnixSocket) databaseUrl.searchParams.set("host", DB_HOST);
  } else {
    const connectionString = environment.DATABASE_URL?.trim();
    if (!connectionString) {
      throw new Error(
        "Set DATABASE_URL or all of DB_HOST, DB_NAME, DB_USER, and DB_PASSWORD.",
      );
    }
    const normalizedConnectionString = connectionString.replace(
      /^(postgres(?:ql)?:\/\/[^@]+)@\/([^?]+)(\?.*)?$/,
      "$1@localhost/$2$3",
    );
    try {
      databaseUrl = new URL(normalizedConnectionString);
    } catch {
      throw new Error("The configured database connection string is invalid.");
    }
    if (!["postgres:", "postgresql:"].includes(databaseUrl.protocol)) {
      throw new Error("The configured database connection string must use PostgreSQL.");
    }
  }

  const socketHost = isUnixSocket
    ? DB_HOST
    : databaseUrl.searchParams.get("host")?.startsWith("/")
      ? databaseUrl.searchParams.get("host")
      : null;
  if (socketHost) {
    databaseUrl.hostname = "localhost";
    databaseUrl.port = "";
    databaseUrl.searchParams.set("host", socketHost);
    databaseUrl.searchParams.delete("port");
    databaseUrl.searchParams.delete("sslmode");
    databaseUrl.searchParams.delete("sslrootcert");
  } else if (ssl === "false") {
    databaseUrl.searchParams.delete("sslmode");
    databaseUrl.searchParams.delete("sslrootcert");
  } else {
    throw new Error("DB_SSL=true is unsupported; Cloud SQL connections use the authenticated connector.");
  }

  databaseUrl.searchParams.set("connect_timeout", "15");
  databaseUrl.searchParams.set("pool_timeout", "15");
  databaseUrl.searchParams.set("connection_limit", String(configuredPoolMax));
  databaseUrl.searchParams.set("max_lifetime", "300");

  return databaseUrl.toString();
}

export async function connectWithRetry(connect, { maxWaitMs = 30_000, onRetry } = {}) {
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
