import nextEnv from "@next/env";
import {
  NotificationChannel,
  NotificationStatus,
  PrismaClient,
} from "@prisma/client";
import { createDecipheriv, createHash } from "node:crypto";
import nodemailer from "nodemailer";

nextEnv.loadEnvConfig(process.cwd());

const db = new PrismaClient({ log: ["error"] });
const MAX_ATTEMPTS = 6;
const POLL_INTERVAL_MS = 3000;
const STALE_CLAIM_MS = 5 * 60 * 1000;
let stopping = false;
let transporter;

class PermanentDeliveryError extends Error {}

function decryptSecret(encrypted) {
  const [ivPart, tagPart, ciphertextPart] = encrypted.split(".");
  const key = process.env.APP_ENCRYPTION_KEY;
  if (!ivPart || !tagPart || !ciphertextPart || !key || key.length < 32) {
    throw new PermanentDeliveryError("The encrypted password recovery payload is unavailable.");
  }
  const decipher = createDecipheriv(
    "aes-256-gcm",
    createHash("sha256").update(key).digest(),
    Buffer.from(ivPart, "base64url"),
  );
  decipher.setAuthTag(Buffer.from(tagPart, "base64url"));
  return Buffer.concat([
    decipher.update(Buffer.from(ciphertextPart, "base64url")),
    decipher.final(),
  ]).toString("utf8");
}

function sanitizeError(error) {
  const message = error instanceof Error ? error.message : "Unknown notification error";
  return message
    .replace(/(password|token|secret|authorization|credential)[=: ]+[^ ,;]+/gi, "$1=[redacted]")
    .replace(/https?:\/\/[^/ ]+\/[^ ]+/gi, "[provider endpoint]")
    .slice(0, 400);
}

function mailTransport() {
  if (transporter) return transporter;
  if (!process.env.SMTP_HOST || !process.env.SMTP_FROM) {
    throw new PermanentDeliveryError("SMTP is not configured.");
  }
  const port = Number(process.env.SMTP_PORT || 587);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new PermanentDeliveryError("SMTP_PORT is invalid.");
  }
  transporter = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port,
    secure: process.env.SMTP_SECURE === "true",
    ...(process.env.SMTP_USER
      ? { auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASSWORD || "" } }
      : {}),
    connectionTimeout: 10_000,
    greetingTimeout: 10_000,
    socketTimeout: 15_000,
  });
  return transporter;
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function messageFor(job) {
  const data = job.templateData && typeof job.templateData === "object"
    ? job.templateData
    : {};
  switch (job.eventType) {
    case "ORDER_REQUESTED":
      return {
        subject: `New request ${data.orderNumber}`,
        text: `A new order request was received.\nBuyer: ${data.customerName}\nContact: ${data.customerEmail || data.customerPhone}\nItems: ${data.items}\nReview it in the shop dashboard.`,
      };
    case "ORDER_STATUS_UPDATED": {
      const fromStatus = String(data.fromStatus ?? "").replaceAll("_", " ").toLowerCase();
      const toStatus = String(data.toStatus ?? "").replaceAll("_", " ").toLowerCase();
      return {
        subject: `Status update for your request ${data.orderNumber}`,
        text: fromStatus
          ? `The status of your request ${data.orderNumber} has changed from ${fromStatus} to ${toStatus}.\nSign in to My Requests to see the latest details.`
          : `Your request ${data.orderNumber} has been received and is now ${toStatus}.\nSign in to My Requests to follow its progress.`,
      };
    }
    case "ORDER_TERMS_CONFIRMED":
      return {
        subject: `Your request ${data.orderNumber}: terms are ready`,
        text: `The shop has confirmed the final terms for ${data.orderNumber}.\nFinal amount: ₹${data.finalAmount}\nPlease sign in to your account to review and accept the terms before arranging payment.`,
      };
    case "ORDER_PAYMENT_VERIFIED":
      return {
        subject: `Payment verified for ${data.orderNumber}`,
        text: `The shop has verified your payment for ${data.orderNumber}. The team will prepare your order.`,
      };
    case "ORDER_DISPATCHED":
      return {
        subject: `Your request ${data.orderNumber} is on its way`,
        text: `Your order has been dispatched with ${data.courier}.${data.trackingNumber ? ` Tracking reference: ${data.trackingNumber}` : " Tracking information is not available yet."}`,
      };
    case "ORDER_CANCELLED":
      return {
        subject: `An update about request ${data.orderNumber}`,
        text: `Your request ${data.orderNumber} has been cancelled.\nReason: ${data.reason}${data.refundFollowUp ? `\n${data.refundFollowUp}` : ""}\nPlease contact the shop if you have any questions.`,
      };
    case "PASSWORD_RESET": {
      const token = decryptSecret(String(data.encryptedToken ?? ""));
      const origin = process.env.APP_ORIGIN;
      if (!origin) throw new PermanentDeliveryError("APP_ORIGIN is not configured.");
      return {
        subject: "Reset your New Chandan Musicals password",
        text: `Use this link to reset your password. It expires in 30 minutes and works once:\n${new URL(`/reset-password?token=${encodeURIComponent(token)}`, origin).toString()}\n\nIf you did not request a reset, you can ignore this message.`,
      };
    }
    default:
      throw new PermanentDeliveryError("This email event has no configured template.");
  }
}

async function deliverEmail(job) {
  const message = messageFor(job);
  await mailTransport().sendMail({
    from: process.env.SMTP_FROM,
    to: job.recipient,
    subject: message.subject,
    text: message.text,
    html: `<div style="font-family:Arial,sans-serif;white-space:pre-line">${escapeHtml(message.text)}</div>`,
  });
}

async function deliverSms(job) {
  if (!process.env.SMS_PROVIDER_URL || !process.env.SMS_PROVIDER_TOKEN) {
    throw new PermanentDeliveryError("SMS provider is not configured.");
  }
  if (!["https:", "http:"].includes(new URL(process.env.SMS_PROVIDER_URL).protocol)) {
    throw new PermanentDeliveryError("SMS provider URL must use HTTP or HTTPS.");
  }
  const data = job.templateData && typeof job.templateData === "object"
    ? job.templateData
    : {};
  const text =
    job.eventType === "ORDER_DISPATCHED"
      ? `New Chandan Musicals: request ${data.orderNumber} has been dispatched with ${data.courier}.${data.trackingNumber ? ` Tracking: ${data.trackingNumber}.` : ""}`
      : `New Chandan Musicals update for request ${data.orderNumber}.`;
  const response = await fetch(process.env.SMS_PROVIDER_URL, {
    method: "POST",
    headers: {
      authorization: `Bearer ${process.env.SMS_PROVIDER_TOKEN}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ to: job.recipient, message: text }),
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) {
    if (response.status >= 400 && response.status < 500 && response.status !== 408 && response.status !== 429) {
      throw new PermanentDeliveryError(`SMS provider rejected the request (${response.status}).`);
    }
    throw new Error(`SMS provider temporarily failed (${response.status}).`);
  }
}

async function claimJob() {
  return db.$transaction(async (tx) => {
    const staleBefore = new Date(Date.now() - STALE_CLAIM_MS);
    await tx.notificationJob.updateMany({
      where: { status: NotificationStatus.PROCESSING, claimedAt: { lt: staleBefore } },
      data: {
        status: NotificationStatus.RETRY,
        claimedAt: null,
        nextAttemptAt: new Date(),
        lastError: "Worker claim expired; the job was safely returned to the queue.",
      },
    });
    const jobs = await tx.$queryRaw`
      SELECT * FROM "NotificationJob"
      WHERE status IN ('PENDING'::"NotificationStatus", 'RETRY'::"NotificationStatus")
        AND "nextAttemptAt" <= NOW()
      ORDER BY "nextAttemptAt" ASC, "createdAt" ASC
      FOR UPDATE SKIP LOCKED
      LIMIT 1
    `;
    const job = jobs[0];
    if (!job) return null;
    return tx.notificationJob.update({
      where: { id: job.id },
      data: {
        status: NotificationStatus.PROCESSING,
        attempts: { increment: 1 },
        claimedAt: new Date(),
      },
    });
  });
}

async function processJob(job) {
  try {
    if (job.channel === NotificationChannel.EMAIL) {
      await deliverEmail(job);
    } else {
      await deliverSms(job);
    }
    await db.notificationJob.update({
      where: { id: job.id },
      data: {
        status: NotificationStatus.SENT,
        sentAt: new Date(),
        claimedAt: null,
        lastError: null,
      },
    });
  } catch (error) {
    const permanent = error instanceof PermanentDeliveryError;
    const failed = permanent || job.attempts >= MAX_ATTEMPTS;
    const delayMinutes = Math.min(24 * 60, 0.5 * 2 ** Math.max(job.attempts - 1, 0));
    const safeMessage = sanitizeError(error);
    await db.notificationJob.update({
      where: { id: job.id },
      data: {
        status: failed ? NotificationStatus.FAILED : NotificationStatus.RETRY,
        nextAttemptAt: new Date(Date.now() + delayMinutes * 60_000),
        claimedAt: null,
        lastError: safeMessage,
      },
    });
    console.error(
      JSON.stringify({
        event: "notification_delivery_failed",
        notificationId: job.id,
        orderId: job.orderId,
        attempts: job.attempts,
        state: failed ? "failed" : "retry",
        error: safeMessage,
      }),
    );
  }
}

async function run() {
  console.log("Notification worker started.");
  while (!stopping) {
    try {
      await db.workerHeartbeat.upsert({
        where: { id: "notifications" },
        create: { id: "notifications" },
        update: { updatedAt: new Date() },
      });
      const job = await claimJob();
      if (job) await processJob(job);
      else await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
    } catch (error) {
      console.error(
        JSON.stringify({
          event: "notification_worker_error",
          error: sanitizeError(error),
        }),
      );
      await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
    }
  }
}

async function shutdown() {
  if (stopping) return;
  stopping = true;
  await db.$disconnect();
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
run().catch(async (error) => {
  console.error("Notification worker could not start.", sanitizeError(error));
  await db.$disconnect();
  process.exitCode = 1;
});
