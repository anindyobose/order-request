import { createHash, createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { GraphQLError } from "graphql";

export function hashSecret(secret: string) {
  return createHash("sha256").update(secret).digest("hex");
}

export function newOpaqueToken() {
  return randomBytes(32).toString("base64url");
}

function encryptionKey() {
  const secret = process.env.APP_ENCRYPTION_KEY;
  if (!secret || secret.length < 32) {
    throw new Error("APP_ENCRYPTION_KEY must contain at least 32 characters.");
  }
  return createHash("sha256").update(secret).digest();
}

export function encryptSecret(plaintext: string) {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", encryptionKey(), iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return `${iv.toString("base64url")}.${cipher.getAuthTag().toString("base64url")}.${ciphertext.toString("base64url")}`;
}

export function decryptSecret(encrypted: string) {
  const [ivPart, tagPart, ciphertextPart] = encrypted.split(".");
  if (!ivPart || !tagPart || !ciphertextPart) {
    throw new Error("The encrypted notification payload is invalid.");
  }
  const decipher = createDecipheriv(
    "aes-256-gcm",
    encryptionKey(),
    Buffer.from(ivPart, "base64url"),
  );
  decipher.setAuthTag(Buffer.from(tagPart, "base64url"));
  return Buffer.concat([
    decipher.update(Buffer.from(ciphertextPart, "base64url")),
    decipher.final(),
  ]).toString("utf8");
}

export function assertSameOrigin(request: Request) {
  const origin = request.headers.get("origin");
  if (!origin) return;
  let originValue: string;
  let expectedOrigin: string;
  try {
    originValue = new URL(origin).origin;
    expectedOrigin = new URL(process.env.APP_ORIGIN || request.url).origin;
  } catch {
    throw new GraphQLError("Cross-origin requests are not allowed.", {
      extensions: { code: "FORBIDDEN" },
    });
  }
  if (originValue !== expectedOrigin) {
    throw new GraphQLError("Cross-origin requests are not allowed.", {
      extensions: { code: "FORBIDDEN" },
    });
  }
}

export function sanitizeError(error: unknown) {
  const message = error instanceof Error ? error.message : "Unknown notification error";
  return message
    .replace(/(password|token|secret|authorization|credential)[=: ]+[^ ,;]+/gi, "$1=[redacted]")
    .replace(/https?:\/\/[^/ ]+\/[^ ]+/gi, "[provider endpoint]")
    .slice(0, 400);
}
