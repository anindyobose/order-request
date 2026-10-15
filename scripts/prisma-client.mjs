import { PrismaClient } from "@prisma/client";
import { createDatabaseUrl } from "./db-config.mjs";

export function createPrismaClient() {
  process.env.DATABASE_URL = createDatabaseUrl();
  const client = new PrismaClient({
    log: [{ emit: "event", level: "error" }],
  });
  client.$on("error", (event) => {
    console.error("Prisma database pool reported an error.", {
      target: event.target,
      timestamp: event.timestamp.toISOString(),
    });
  });
  return client;
}
