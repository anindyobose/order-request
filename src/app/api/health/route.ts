import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";

export async function GET(request: Request) {
  const accept = request.headers.get("accept");
  if (accept && !accept.includes("application/json") && !accept.includes("*/*")) {
    return NextResponse.json({ error: "The health endpoint returns JSON." }, { status: 406 });
  }
  let database = "ok";
  let worker = "stale";
  try {
    await prisma.$queryRaw`SELECT 1`;
    const heartbeat = await prisma.workerHeartbeat.findUnique({
      where: { id: "notifications" },
    });
    if (heartbeat && Date.now() - heartbeat.updatedAt.getTime() < 120_000) {
      worker = "ok";
    }
  } catch (error) {
    console.error("Health check could not reach PostgreSQL.", error);
    database = "unavailable";
  }
  const status = database === "ok" && worker === "ok" ? 200 : 503;
  return NextResponse.json(
    { status: status === 200 ? "ok" : "degraded", database, notificationWorker: worker },
    { status, headers: { "cache-control": "no-store" } },
  );
}
