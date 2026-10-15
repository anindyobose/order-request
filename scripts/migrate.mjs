import { spawn } from "node:child_process";
import { createDatabaseUrl } from "./db-config.mjs";

process.env.DATABASE_URL = createDatabaseUrl();

let activeChild;
let stopped = false;

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    stopped = true;
    activeChild?.kill(signal);
  });
}

function runMigration() {
  return new Promise((resolve, reject) => {
    activeChild = spawn(
      process.execPath,
      ["node_modules/prisma/build/index.js", "migrate", "deploy"],
      { env: process.env, stdio: "inherit" },
    );
    activeChild.once("error", reject);
    activeChild.once("exit", (code, signal) => {
      activeChild = undefined;
      if (code === 0) resolve();
      else reject(new Error(`Prisma migrate deploy exited with ${signal || `code ${code}`}.`));
    });
  });
}

const deadline = Date.now() + 30_000;
let attempt = 0;
let delayMs = 1000;

while (!stopped) {
  try {
    await runMigration();
    console.log("Database migrations are up to date.");
    process.exit(0);
  } catch (error) {
    if (stopped) break;
    attempt += 1;
    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0) {
      console.error("Database migrations failed after approximately 30 seconds of retries.");
      process.exitCode = 1;
      break;
    }
    const waitMs = Math.min(delayMs, remainingMs);
    console.warn(`Database migration attempt ${attempt} failed; retrying in ${waitMs}ms.`, error.message);
    await new Promise((resolve) => setTimeout(resolve, waitMs));
    delayMs = Math.min(delayMs * 2, 10_000);
  }
}
