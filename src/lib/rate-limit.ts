import { prisma } from "@/lib/db";
import { hashSecret } from "@/lib/security";

export class RateLimitError extends Error {
  readonly retryAfterSeconds: number;

  constructor(retryAfterSeconds: number) {
    super("Too many requests. Please wait and try again.");
    this.name = "RateLimitError";
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

export async function enforceRateLimit(
  key: string,
  limit: number,
  windowMs: number,
) {
  const now = new Date();
  const windowStart = new Date(now.getTime() - windowMs);
  const safeKey = hashSecret(key);
  const state = await prisma.rateLimit.upsert({
    where: { key: safeKey },
    create: { key: safeKey, count: 1, windowAt: now },
    update: { count: { increment: 1 } },
  });
  if (state.windowAt < windowStart) {
    await prisma.rateLimit.updateMany({
      where: { key: safeKey, windowAt: state.windowAt },
      data: { count: 1, windowAt: now },
    });
    return;
  }
  if (state.count > limit) {
    throw new RateLimitError(Math.ceil(windowMs / 1000));
  }
}
