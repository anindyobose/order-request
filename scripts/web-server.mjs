import { createServer } from "node:http";
import next from "next";
import { connectWithRetry } from "./db-config.mjs";
import { createPrismaClient } from "./prisma-client.mjs";

const prisma = createPrismaClient();
const hostname = "0.0.0.0";
const port = Number(process.env.PORT || 3000);
if (!Number.isInteger(port) || port < 1 || port > 65535) {
  throw new Error("PORT must be a valid TCP port.");
}

let server;
let app;
let stopping = false;
let shutdownPromise;

async function shutdown() {
  if (shutdownPromise) return shutdownPromise;
  stopping = true;
  shutdownPromise = (async () => {
    if (server?.listening) {
      let forceCloseTimer;
      const closed = new Promise((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
      server.closeIdleConnections();
      forceCloseTimer = setTimeout(() => server.closeAllConnections(), 7000);
      forceCloseTimer.unref();
      try {
        await closed;
      } finally {
        clearTimeout(forceCloseTimer);
      }
    }
    if (app) await app.close();
    await prisma.$disconnect();
    console.log("Web server stopped cleanly.");
  })();
  return shutdownPromise;
}

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    void shutdown().catch((error) => {
      console.error("Web server shutdown failed.", error);
      process.exitCode = 1;
    });
  });
}

async function start() {
  await connectWithRetry(() => prisma.$connect(), {
    onRetry: (attempt, delayMs) => {
      console.warn(`Database is not ready; retrying web startup (attempt ${attempt}) in ${delayMs}ms.`);
    },
  });
  if (stopping) {
    await shutdown();
    return;
  }

  app = next({ dev: false, hostname, port });
  await app.prepare();
  if (stopping) {
    await shutdown();
    return;
  }

  const handleRequest = app.getRequestHandler();
  server = createServer((request, response) => {
    void handleRequest(request, response).catch((error) => {
      console.error("Next.js request handler failed.", error);
      if (response.headersSent) response.destroy(error);
      else response.writeHead(500).end("Internal server error");
    });
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, hostname, resolve);
  });
  console.log(`Web server listening on ${hostname}:${port}.`);
}

start().catch(async (error) => {
  console.error("Web server could not start.", error);
  process.exitCode = 1;
  await shutdown();
});
