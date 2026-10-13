import { Role, User } from "@prisma/client";
import { GraphQLError } from "graphql";
import { cookies } from "next/headers";
import { prisma } from "@/lib/db";
import { hashSecret } from "@/lib/security";

export const SESSION_COOKIE = "ncm_session";
export const SESSION_DURATION_MS = 30 * 24 * 60 * 60 * 1000;

export type AuthUser = Pick<User, "id" | "name" | "email" | "phone" | "role" | "status">;
export type AuthContext = {
  user: AuthUser | null;
  sessionId: string | null;
  request: Request;
};

const publicUserSelect = {
  id: true,
  name: true,
  email: true,
  phone: true,
  role: true,
  status: true,
} as const;

export async function currentUserFromRequest(request: Request) {
  const token = request.headers
    .get("cookie")
    ?.split(";")
    .map((item) => item.trim())
    .find((item) => item.startsWith(`${SESSION_COOKIE}=`))
    ?.slice(SESSION_COOKIE.length + 1);
  if (!token) return { user: null, sessionId: null };
  const session = await prisma.session.findUnique({
    where: { tokenHash: hashSecret(token) },
    include: { user: { select: publicUserSelect } },
  });
  if (!session || session.expiresAt <= new Date() || session.user.status !== "ACTIVE") {
    if (session) await prisma.session.deleteMany({ where: { id: session.id } });
    return { user: null, sessionId: null };
  }
  return { user: session.user, sessionId: session.id };
}

export async function currentCookieUser() {
  const cookieStore = await cookies();
  const token = cookieStore.get(SESSION_COOKIE)?.value;
  if (!token) return null;
  const session = await prisma.session.findUnique({
    where: { tokenHash: hashSecret(token) },
    include: { user: { select: publicUserSelect } },
  });
  if (!session || session.expiresAt <= new Date() || session.user.status !== "ACTIVE") {
    if (session) await prisma.session.deleteMany({ where: { id: session.id } });
    return null;
  }
  return session.user;
}

export function requireUser(user: AuthUser | null) {
  if (!user) {
    throw new GraphQLError("Sign in to continue.", {
      extensions: { code: "UNAUTHENTICATED" },
    });
  }
  if (user.status !== "ACTIVE") {
    throw new GraphQLError("This account cannot access the requested resource.", {
      extensions: { code: "FORBIDDEN" },
    });
  }
  return user;
}

export function requireRole(user: AuthUser | null, roles: Role[]) {
  const authorizedUser = requireUser(user);
  if (!roles.includes(authorizedUser.role)) {
    throw new GraphQLError("This action requires staff permission.", {
      extensions: { code: "FORBIDDEN" },
    });
  }
  return authorizedUser;
}
