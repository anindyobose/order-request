import nextEnv from "@next/env";
import { Role } from "@prisma/client";
import { hash } from "bcryptjs";
import catalog from "../prisma/catalog.seed.json" with { type: "json" };
import { createPrismaClient } from "./prisma-client.mjs";

nextEnv.loadEnvConfig(process.cwd());

const email = process.env.ADMIN_EMAIL?.trim().toLowerCase();
const password = process.env.ADMIN_PASSWORD;
const name = process.env.ADMIN_NAME?.trim() || "Shop Administrator";

if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
  throw new Error("Set ADMIN_EMAIL to a valid address before creating the first admin.");
}
if (
  !password ||
  password.length < 12 ||
  password.length > 128 ||
  !/[a-z]/.test(password) ||
  !/[A-Z]/.test(password) ||
  !/[0-9]/.test(password)
) {
  throw new Error("Set ADMIN_PASSWORD to a unique 12+ character password with upper, lower and numeric characters.");
}

const db = createPrismaClient();
try {
  const existing = await db.user.findUnique({ where: { email } });
  if (existing) {
    if (existing.role !== Role.ADMIN) {
      throw new Error("That email belongs to a non-admin account; no account was changed.");
    }
    console.log("The configured administrator account already exists; no password was changed.");
  } else {
    await db.user.create({
      data: {
        email,
        name,
        passwordHash: await hash(password, 12),
        role: Role.ADMIN,
      },
    });
    console.log(`Created the shop administrator account for ${email}.`);
  }
  const recipients = (process.env.ADMIN_NOTIFICATION_EMAILS ?? email)
    .split(",")
    .map((recipient) => recipient.trim().toLowerCase())
    .filter(Boolean);
  await db.notificationSettings.upsert({
    where: { id: "global" },
    create: { id: "global", adminRecipients: recipients },
    update: {},
  });
  for (const { image, altText, ...product } of catalog) {
    const savedProduct = await db.product.upsert({
      where: { sku: product.sku },
      create: product,
      update: {
        slug: product.slug,
        name: product.name,
        description: product.description,
        category: product.category,
        brand: product.brand,
        price: product.price,
        priceMode: product.priceMode,
        stockStatus: product.stockStatus,
        sortOrder: product.sortOrder,
      },
    });
    await db.productImage.upsert({
      where: { id: `seed-${savedProduct.id}` },
      create: {
        id: `seed-${savedProduct.id}`,
        productId: savedProduct.id,
        url: image,
        altText,
        sortOrder: 0,
      },
      update: { url: image, altText, sortOrder: 0 },
    });
  }
  console.log(`Catalog ready (${catalog.length} initial products).`);
  console.log("Notification settings are ready. SMTP and SMS remain disabled until configured.");
} finally {
  await db.$disconnect();
}
