import { describe, expect, it } from "vitest";
import { createDatabaseUrl } from "./db-config.mjs";

describe("database connection configuration", () => {
  it("uses DATABASE_URL and enforces bounded Prisma pool settings", () => {
    const url = new URL(
      createDatabaseUrl({
        DATABASE_URL: "postgresql://user:pass@localhost:5432/shop?schema=public",
      }),
    );

    expect(url.hostname).toBe("localhost");
    expect(url.searchParams.get("schema")).toBe("public");
    expect(url.searchParams.get("connect_timeout")).toBe("30");
    expect(url.searchParams.get("pool_timeout")).toBe("30");
    expect(url.searchParams.get("connection_limit")).toBe("10");
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

  it("rejects missing, non-PostgreSQL, and invalid TLS configuration", () => {
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
  });
});
