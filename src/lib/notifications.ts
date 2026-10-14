import {
  NotificationChannel,
  NotificationSettings,
  Order,
  OrderItem,
  OrderStatus,
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

export async function enqueueBuyerStatusNotice(
  db: NotificationTransaction,
  eventId: string,
  order: OrderNotice,
  fromStatus: OrderStatus | null,
  toStatus: OrderStatus,
  email: string | null,
) {
  if (!email) return;
  const idempotencyKey = `${order.orderNumber}:STATUS:${eventId}:EMAIL:${email.toLowerCase()}`;
  await db.notificationJob.upsert({
    where: { idempotencyKey },
    create: {
      idempotencyKey,
      orderId: order.id,
      eventType: "ORDER_STATUS_UPDATED",
      channel: NotificationChannel.EMAIL,
      recipient: email,
      templateData: {
        orderNumber: order.orderNumber,
        fromStatus: fromStatus ?? "",
        toStatus,
      },
    },
    update: {},
  });
}

export async function enqueueBuyerDispatchSms(
  db: NotificationTransaction,
  order: OrderNotice,
  phone: string | null,
  templateData: Prisma.InputJsonObject,
) {
  if (!phone) return;
  const settings = await notificationSettings(db);
  if (
    settings.buyerDispatchSmsEnabled &&
    process.env.SMS_PROVIDER_URL &&
    process.env.SMS_PROVIDER_TOKEN
  ) {
    const idempotencyKey = `${order.orderNumber}:ORDER_DISPATCHED:SMS:${phone}`;
    await db.notificationJob.upsert({
      where: { idempotencyKey },
      create: {
        idempotencyKey,
        orderId: order.id,
        eventType: "ORDER_DISPATCHED",
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
