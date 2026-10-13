import { NextResponse } from "next/server";
import { createYoga } from "graphql-yoga";
import { AuthContext, currentUserFromRequest } from "@/lib/auth";
import { schema } from "@/lib/graphql-schema";
import { assertSameOrigin } from "@/lib/security";

const yoga = createYoga<AuthContext>({
  schema,
  graphqlEndpoint: "/api/graphql",
  graphiql: process.env.NODE_ENV !== "production",
  cors: false,
  context: async ({ request }) => {
    assertSameOrigin(request);
    return { ...(await currentUserFromRequest(request)), request };
  },
  logging: process.env.NODE_ENV === "development" ? "warn" : "error",
});

const MAX_GRAPHQL_BODY_BYTES = 128 * 1024;

export async function POST(request: Request) {
  const contentLength = Number(request.headers.get("content-length") ?? 0);
  if (contentLength > MAX_GRAPHQL_BODY_BYTES) {
    return NextResponse.json({ errors: [{ message: "GraphQL request is too large." }] }, { status: 413 });
  }
  const reader = request.body?.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  if (reader) {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      totalBytes += value.byteLength;
      if (totalBytes > MAX_GRAPHQL_BODY_BYTES) {
        await reader.cancel();
        return NextResponse.json({ errors: [{ message: "GraphQL request is too large." }] }, { status: 413 });
      }
      chunks.push(value);
    }
    reader.releaseLock();
  }
  const body = Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)));
  const headers = new Headers(request.headers);
  headers.delete("content-length");
  headers.delete("transfer-encoding");
  return yoga.fetch(
    new Request(request.url, {
      method: request.method,
      headers,
      body,
    }),
  );
}

export function GET(request: Request) {
  if (request.url.length > 8_192) {
    return NextResponse.json({ errors: [{ message: "GraphQL request is too large." }] }, { status: 413 });
  }
  return yoga.fetch(request);
}
