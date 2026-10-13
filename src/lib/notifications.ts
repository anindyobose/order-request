import {
  NotificationChannel,
  NotificationSettings,
  Order,
  OrderItem,
  Prisma,
} from "@prisma/client";
import { prisma } from "@/lib/db";

type NotificationTransaction = Prisma.TransactionClient;

export async function notificationSettings(
  db: NotificationTransaction | typeof prisma = prisma,
): Promise<NotificationSettings> {
  return db.notificationSettings.upsert({
    where: { id: "global" },
    create: { id: "global" },
    update: {},
  });
}

type OrderNotice = Pick<Order, "id" | "orderNumber" | "finalAmount" | "deliveryFee">;

export async function enqueueOrderEmail(
  db: NotificationTransaction,
  order: OrderNotice,
  eventType: string,
  recipient: string,
  templateData: Prisma.InputJsonObject,
) {
  await db.notificationJob.upsert({
    where: {
      idempotencyKey: `${order.orderNumber}:${eventType}:EMAIL:${recipient.toLowerCase()}`,
    },
    create: {
      idempotencyKey: `${order.orderNumber}:${eventType}:EMAIL:${recipient.toLowerCase()}`,
      orderId: order.id,
      eventType,
      channel: NotificationChannel.EMAIL,
      recipient,
      templateData,
    },
    update: {},
  });
}

export async function enqueueConfiguredAdminNotices(
  db: NotificationTransaction,
  order: OrderNotice,
  eventType: string,
  templateData: Prisma.InputJsonObject,
) {
  const settings = await notificationSettings(db);
  if (eventType === "ORDER_REQUESTED" && !settings.newOrderEmailEnabled) return;
  for (const recipient of settings.adminRecipients) {
    await enqueueOrderEmail(db, order, eventType, recipient, templateData);
  }
}

export async function enqueueBuyerNotices(
  db: NotificationTransaction,
  order: OrderNotice,
  eventType: string,
  email: string | null,
  phone: string | null,
  templateData: Prisma.InputJsonObject,
) {
  const settings = await notificationSettings(db);
  const enabled =
    eventType === "ORDER_TERMS_CONFIRMED"
      ? settings.buyerTermsEmailEnabled
      : eventType === "ORDER_PAYMENT_VERIFIED"
        ? settings.buyerPaymentEmailEnabled
        : eventType === "ORDER_CANCELLED"
          ? settings.buyerCancellationEmailEnabled
          : settings.buyerDispatchEmailEnabled;
  if (email && enabled) {
    await enqueueOrderEmail(
      db,
      order,
      eventType,
      email,
      templateData,
    );
  }
  if (
    eventType === "ORDER_DISPATCHED" &&
    phone &&
    settings.buyerDispatchSmsEnabled &&
    process.env.SMS_PROVIDER_URL &&
    process.env.SMS_PROVIDER_TOKEN
  ) {
    const idempotencyKey = `${order.orderNumber}:${eventType}:SMS:${phone}`;
    await db.notificationJob.upsert({
      where: { idempotencyKey },
      create: {
        idempotencyKey,
        orderId: order.id,
        eventType,
        channel: NotificationChannel.SMS,
        recipient: phone,
        templateData,
      },
      update: {},
    });
  }
}

export async function enqueuePasswordReset(
  db: NotificationTransaction,
  email: string,
  encryptedToken: string,
  expiresAt: Date,
) {
  const idempotencyKey = `password-reset:${email.toLowerCase()}:${encryptedToken.slice(0, 32)}`;
  await db.notificationJob.create({
    data: {
      idempotencyKey,
      eventType: "PASSWORD_RESET",
      channel: NotificationChannel.EMAIL,
      recipient: email,
      nextAttemptAt: new Date(),
      templateData: {
        encryptedToken,
        expiresAt: expiresAt.toISOString(),
      },
    },
  });
}

export function orderItemsSummary(items: Array<Pick<OrderItem, "productNameSnapshot" | "quantity">>) {
  return items
    .map((item) => `${item.quantity} × ${item.productNameSnapshot}`)
    .join(", ");
}
