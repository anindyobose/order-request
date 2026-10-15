import { describe, expect, it } from "vitest";
import { createDatabaseUrl } from "./db-config.mjs";

describe("database connection configuration", () => {
  it("uses DATABASE_URL and enforces a small Prisma pool", () => {
    const url = new URL(
      createDatabaseUrl({
        DATABASE_URL: "postgresql://user:pass@localhost:5432/shop?schema=public",
      }),
    );

    expect(url.hostname).toBe("localhost");
    expect(url.searchParams.get("schema")).toBe("public");
    expect(url.searchParams.get("connect_timeout")).toBe("15");
    expect(url.searchParams.get("pool_timeout")).toBe("15");
    expect(url.searchParams.get("connection_limit")).toBe("5");
    expect(url.searchParams.get("max_lifetime")).toBe("300");
    expect(url.searchParams.has("sslmode")).toBe(false);
  });

  it("builds an encoded PostgreSQL URL from DB variables when DATABASE_URL is absent", () => {
    const url = new URL(
      createDatabaseUrl({
        DB_HOST: "postgres.internal",
        DB_PORT: "5432",
        DB_NAME: "shop data",
        DB_USER: "shop user",
        DB_PASSWORD: "pass@word:with/slashes",
      }),
    );

    expect(url.hostname).toBe("postgres.internal");
    expect(url.pathname).toBe("/shop%20data");
    expect(url.username).toBe("shop%20user");
    expect(url.password).toBe("pass%40word%3Awith%2Fslashes");
  });

  it("uses a Unix socket for a socket-directory DB_HOST and does not enable TLS", () => {
    const url = new URL(
      createDatabaseUrl({
        DB_HOST: "/cloudsql/project:asia-south1:instance",
        DB_PORT: "5432",
        DB_NAME: "shop",
        DB_USER: "user",
        DB_PASSWORD: "pass",
        DB_SSL: "false",
      }),
    );

    expect(url.hostname).toBe("localhost");
    expect(url.port).toBe("");
    expect(url.searchParams.get("host")).toBe("/cloudsql/project:asia-south1:instance");
    expect(url.searchParams.has("sslmode")).toBe(false);
  });

  it("converts a Cloud SQL libpq URL and validates pool and TLS settings", () => {
    const socketUrl = new URL(
      createDatabaseUrl({
        DATABASE_URL: "postgresql://user:pass@/shop?host=%2Fcloudsql%2Fproject%3Aregion%3Ainstance",
      }),
    );
    expect(socketUrl.searchParams.get("host")).toBe("/cloudsql/project:region:instance");

    expect(() => createDatabaseUrl({})).toThrow("Set DATABASE_URL or all of DB_HOST");
    expect(() => createDatabaseUrl({ DATABASE_URL: "mysql://localhost/shop" })).toThrow(
      "must use PostgreSQL",
    );
    expect(() =>
      createDatabaseUrl({
        DATABASE_URL: "postgresql://user:pass@localhost:5432/shop",
        DB_SSL: "sometimes",
      }),
    ).toThrow("DB_SSL must be either true or false");
    expect(() =>
      createDatabaseUrl({
        DATABASE_URL: "postgresql://user:pass@localhost:5432/shop",
        DB_POOL_MAX: "6",
      }),
    ).toThrow("DB_POOL_MAX must be a whole number between 1 and 5");
  });
});
