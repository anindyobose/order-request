import { createHash } from "node:crypto";
import { createWriteStream } from "node:fs";
import { copyFile, mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import { pipeline } from "node:stream/promises";
import nextEnv from "@next/env";

nextEnv.loadEnvConfig(process.cwd());

const databaseUrl = process.env.DATABASE_URL;
const backupDirectory = process.env.NCM_BACKUP_DIRECTORY;
const offsiteDirectory = process.env.NCM_OFFSITE_BACKUP_DIRECTORY;

if (!databaseUrl || !backupDirectory || !offsiteDirectory) {
  throw new Error("Set DATABASE_URL, NCM_BACKUP_DIRECTORY and NCM_OFFSITE_BACKUP_DIRECTORY.");
}

const localPath = path.resolve(backupDirectory);
const remotePath = path.resolve(offsiteDirectory);
await mkdir(localPath, { recursive: true });
await mkdir(remotePath, { recursive: true });
const [localRealPath, remoteRealPath] = await Promise.all([
  realpath(localPath),
  realpath(remotePath),
]);
if (localRealPath.toLowerCase() === remoteRealPath.toLowerCase()) {
  throw new Error("The offsite backup target must be a separate protected location.");
}

const uri = new URL(databaseUrl);
if (uri.protocol !== "postgresql:" && uri.protocol !== "postgres:") {
  throw new Error("DATABASE_URL must use PostgreSQL.");
}
const databaseName = decodeURIComponent(uri.pathname.slice(1));
if (!databaseName) throw new Error("DATABASE_URL must name a database.");

const timestamp = new Date().toISOString().replaceAll(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
const filename = `new-chandan-${databaseName}-${timestamp}.dump`;
const localFile = path.join(localRealPath, filename);
const remoteFile = path.join(remoteRealPath, filename);
const env = { ...process.env };
if (uri.password) env.PGPASSWORD = decodeURIComponent(uri.password);

const args = [
  "--format=custom",
  "--no-owner",
  "--no-privileges",
  "--host", uri.hostname,
  "--port", uri.port || "5432",
  "--username", decodeURIComponent(uri.username),
  "--dbname", databaseName,
];
const child = spawn("pg_dump", args, { env, windowsHide: true });
const exitCode = new Promise((resolve, reject) => {
  child.once("error", reject);
  child.once("close", resolve);
});
try {
  await pipeline(child.stdout, createWriteStream(localFile, { flags: "wx" }));
  const code = await exitCode;
  if (code !== 0) throw new Error(`pg_dump exited with status ${code}.`);
  const bytes = await readFile(localFile);
  const checksum = createHash("sha256").update(bytes).digest("hex");
  await writeFile(`${localFile}.sha256`, `${checksum}  ${filename}\n`, { flag: "wx" });
  await copyFile(localFile, remoteFile);
  await copyFile(`${localFile}.sha256`, `${remoteFile}.sha256`);
  console.log(`Created and copied PostgreSQL backup ${filename} (${bytes.length} bytes).`);
  console.log(`SHA-256: ${checksum}`);
} catch (error) {
  child.kill();
  throw error;
} finally {
  delete env.PGPASSWORD;
}
