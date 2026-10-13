import { NextRequest, NextResponse } from "next/server";
import { Role, UserStatus } from "@prisma/client";
import { compare, hash } from "bcryptjs";
import { GraphQLError } from "graphql";
import { prisma } from "@/lib/db";
import {
  SESSION_COOKIE,
  SESSION_DURATION_MS,
  currentUserFromRequest,
} from "@/lib/auth";
import { validationError } from "@/lib/domain";
import { enqueuePasswordReset } from "@/lib/notifications";
import { enforceRateLimit, RateLimitError } from "@/lib/rate-limit";
import {
  assertSameOrigin,
  encryptSecret,
  hashSecret,
  newOpaqueToken,
} from "@/lib/security";

type AuthBody = Record<string, unknown>;

const emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const phonePattern = /^\+?[0-9 ()-]{8,20}$/;

function field(body: AuthBody, key: string) {
  return typeof body[key] === "string" ? (body[key] as string).trim() : "";
}

function setSessionCookie(response: NextResponse, token: string) {
  response.cookies.set(SESSION_COOKIE, token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    maxAge: Math.floor(SESSION_DURATION_MS / 1000),
  });
}

function clearSessionCookie(response: NextResponse) {
  response.cookies.set(SESSION_COOKIE, "", {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    expires: new Date(0),
  });
}

function errorResponse(error: unknown) {
  if (error instanceof RateLimitError) {
    return NextResponse.json(
      { error: error.message, code: "RATE_LIMITED" },
      { status: 429, headers: { "Retry-After": String(error.retryAfterSeconds) } },
    );
  }
  if (error instanceof GraphQLError) {
    const code = typeof error.extensions.code === "string"
      ? error.extensions.code
      : "BAD_REQUEST";
    return NextResponse.json(
      { error: error.message, code },
      { status: code === "FORBIDDEN" ? 403 : 400 },
    );
  }
  if (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "P2002"
  ) {
    return NextResponse.json(
      { error: "An account already uses that email address or phone number.", code: "DUPLICATE_ACCOUNT" },
      { status: 409 },
    );
  }
  console.error("Authentication request failed.", error);
  return NextResponse.json(
    { error: "We couldn’t complete that request. Please try again.", code: "INTERNAL_ERROR" },
    { status: 500 },
  );
}

async function readBody(request: NextRequest): Promise<AuthBody> {
  const length = Number(request.headers.get("content-length") ?? 0);
  if (length > 16_384) throw validationError("Request is too large.");
  const bytes = await request.arrayBuffer();
  if (bytes.byteLength > 16_384) throw validationError("Request is too large.");
  let body: unknown;
  try {
    body = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    throw validationError("Send a valid JSON request.");
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw validationError("Send a valid JSON request.");
  }
  return body as AuthBody;
}

async function loginResponse(identifier: string, password: string) {
  const normalizedEmail = identifier.toLowerCase();
  const user = await prisma.user.findFirst({
    where: {
      OR: [
        { email: normalizedEmail },
        { phone: identifier },
      ],
    },
  });
  if (!user || user.status !== UserStatus.ACTIVE || !(await compare(password, user.passwordHash))) {
    return NextResponse.json(
      { error: "Those sign-in details don’t match an active account.", code: "INVALID_CREDENTIALS" },
      { status: 401 },
    );
  }
  const token = newOpaqueToken();
  await prisma.session.create({
    data: {
      tokenHash: hashSecret(token),
      userId: user.id,
      expiresAt: new Date(Date.now() + SESSION_DURATION_MS),
    },
  });
  const response = NextResponse.json({
    user: { id: user.id, name: user.name, email: user.email, phone: user.phone, role: user.role },
  });
  setSessionCookie(response, token);
  return response;
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ action: string }> },
) {
  try {
    assertSameOrigin(request);
    const { action } = await params;
    const body = await readBody(request);
    const ip = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? "unknown";

    if (action === "register") {
      await enforceRateLimit(`register:${ip}`, 5, 60 * 60 * 1000);
      const name = field(body, "name");
      const email = field(body, "email").toLowerCase();
      const phone = field(body, "phone").replace(/[ ()-]/g, "");
      const password = typeof body.password === "string" ? body.password : "";
      if (name.length < 2 || name.length > 100) {
        throw validationError("Enter a name between 2 and 100 characters.");
      }
      if (!email && !phone) {
        throw validationError("Enter an email address or phone number.");
      }
      if (email && !emailPattern.test(email)) throw validationError("Enter a valid email address.");
      if (phone && !phonePattern.test(phone)) throw validationError("Enter a valid phone number.");
      if (password.length < 12 || password.length > 128 || !/[a-z]/.test(password) || !/[A-Z]/.test(password) || !/[0-9]/.test(password)) {
        throw validationError("Use a password with at least 12 characters, including uppercase, lowercase and a number.");
      }
      const passwordHash = await hash(password, 12);
      const token = newOpaqueToken();
      const user = await prisma.$transaction(async (tx) => {
        const createdUser = await tx.user.create({
          data: {
            name,
            email: email || null,
            phone: phone || null,
            passwordHash,
            role: Role.BUYER,
          },
        });
        await tx.session.create({
          data: {
            tokenHash: hashSecret(token),
            userId: createdUser.id,
            expiresAt: new Date(Date.now() + SESSION_DURATION_MS),
          },
        });
        return createdUser;
      });
      const response = NextResponse.json(
        { user: { id: user.id, name: user.name, email: user.email, phone: user.phone, role: user.role } },
        { status: 201 },
      );
      setSessionCookie(response, token);
      return response;
    }

    if (action === "login") {
      await enforceRateLimit(`login:${ip}`, 10, 15 * 60 * 1000);
      const identifier = field(body, "identifier");
      const password = typeof body.password === "string" ? body.password : "";
      if (!identifier || !password) throw validationError("Enter your email or phone number and password.");
      return loginResponse(identifier, password);
    }

    if (action === "logout") {
      const { sessionId } = await currentUserFromRequest(request);
      if (sessionId) await prisma.session.deleteMany({ where: { id: sessionId } });
      const response = NextResponse.json({ success: true });
      clearSessionCookie(response);
      return response;
    }

    if (action === "forgot-password") {
      await enforceRateLimit(`recovery:${ip}`, 5, 60 * 60 * 1000);
      const email = field(body, "email").toLowerCase();
      if (!emailPattern.test(email)) {
        return NextResponse.json({
          message: "If an account matches those details, we’ll send recovery instructions.",
        });
      }
      const user = await prisma.user.findUnique({ where: { email } });
      if (user && user.status === UserStatus.ACTIVE) {
        const token = newOpaqueToken();
        const expiresAt = new Date(Date.now() + 30 * 60 * 1000);
        const encrypted = encryptSecret(token);
        await prisma.$transaction(async (tx) => {
          await tx.passwordResetToken.create({
            data: {
              tokenHash: hashSecret(token),
              userId: user.id,
              expiresAt,
            },
          });
          await enqueuePasswordReset(tx, email, encrypted, expiresAt);
        });
      }
      return NextResponse.json({
        message: "If an account matches those details, we’ll send recovery instructions.",
      });
    }

    if (action === "reset-password") {
      await enforceRateLimit(`reset:${ip}`, 10, 60 * 60 * 1000);
      const token = field(body, "token");
      const password = typeof body.password === "string" ? body.password : "";
      if (!token || token.length > 200) throw validationError("The recovery link is invalid or expired.");
      if (password.length < 12 || password.length > 128 || !/[a-z]/.test(password) || !/[A-Z]/.test(password) || !/[0-9]/.test(password)) {
        throw validationError("Use a password with at least 12 characters, including uppercase, lowercase and a number.");
      }
      const passwordHash = await hash(password, 12);
      await prisma.$transaction(async (tx) => {
        const reset = await tx.passwordResetToken.findUnique({
          where: { tokenHash: hashSecret(token) },
        });
        if (!reset || reset.usedAt || reset.expiresAt <= new Date()) {
          throw validationError("The recovery link is invalid or expired.");
        }
        const claimed = await tx.passwordResetToken.updateMany({
          where: { id: reset.id, usedAt: null, expiresAt: { gt: new Date() } },
          data: { usedAt: new Date() },
        });
        if (claimed.count !== 1) {
          throw validationError("The recovery link is invalid or expired.");
        }
        await tx.user.update({
          where: { id: reset.userId },
          data: { passwordHash },
        });
        await tx.session.deleteMany({ where: { userId: reset.userId } });
        await tx.passwordResetToken.deleteMany({
          where: { userId: reset.userId, id: { not: reset.id } },
        });
      });
      const response = NextResponse.json({ success: true });
      clearSessionCookie(response);
      return response;
    }

    return NextResponse.json({ error: "Unknown authentication action.", code: "NOT_FOUND" }, { status: 404 });
  } catch (error) {
    return errorResponse(error);
  }
}
