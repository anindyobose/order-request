import { access } from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import nextEnv from "@next/env";

nextEnv.loadEnvConfig(process.cwd());

const backupFile = process.env.NCM_RESTORE_FILE;
const targetUrl = process.env.RESTORE_TEST_DATABASE_URL;
if (!backupFile || !targetUrl) {
  throw new Error(
    "Set NCM_RESTORE_FILE to a named dump file and RESTORE_TEST_DATABASE_URL to a dedicated test database URL.",
  );
}
const resolvedBackup = path.resolve(backupFile);
await access(resolvedBackup);
if (path.extname(resolvedBackup) !== ".dump") {
  throw new Error("Restore accepts only one explicit pg_dump custom-format .dump file.");
}

const uri = new URL(targetUrl);
if (!["postgresql:", "postgres:"].includes(uri.protocol)) {
  throw new Error("RESTORE_TEST_DATABASE_URL must use PostgreSQL.");
}
const databaseName = decodeURIComponent(uri.pathname.slice(1));
if (!databaseName.endsWith("_restore_test")) {
  throw new Error("The restore target database name must end in _restore_test.");
}
const env = { ...process.env };
if (uri.password) env.PGPASSWORD = decodeURIComponent(uri.password);
const child = spawn(
  "pg_restore",
  [
    "--clean",
    "--if-exists",
    "--no-owner",
    "--no-privileges",
    "--exit-on-error",
    "--host", uri.hostname,
    "--port", uri.port || "5432",
    "--username", decodeURIComponent(uri.username),
    "--dbname", databaseName,
    resolvedBackup,
  ],
  { env, windowsHide: true, stdio: ["ignore", "inherit", "inherit"] },
);
try {
  const code = await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", resolve);
  });
  if (code !== 0) throw new Error(`pg_restore exited with status ${code}.`);
  console.log(`Restore test succeeded for the named backup into ${databaseName}.`);
} finally {
  delete env.PGPASSWORD;
}
