import { createPrismaClient } from "../../scripts/prisma-client.mjs";

const globalForPrisma = globalThis as typeof globalThis & {
  ncmPrisma?: ReturnType<typeof createPrismaClient>;
};

export const prisma =
  globalForPrisma.ncmPrisma ??
  createPrismaClient();

if (process.env.NODE_ENV !== "production") globalForPrisma.ncmPrisma = prisma;
