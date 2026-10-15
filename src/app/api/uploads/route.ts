import { randomUUID } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { currentUserFromRequest } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { assertSameOrigin } from "@/lib/security";

const MAX_FILE_SIZE = 5 * 1024 * 1024;
const signatures: Array<{ mime: string; extension: string; bytes: number[] }> = [
  { mime: "image/jpeg", extension: "jpg", bytes: [0xff, 0xd8, 0xff] },
  { mime: "image/png", extension: "png", bytes: [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] },
  { mime: "image/webp", extension: "webp", bytes: [0x52, 0x49, 0x46, 0x46, -1, -1, -1, -1, 0x57, 0x45, 0x42, 0x50] },
];

export async function POST(request: NextRequest) {
  try {
    assertSameOrigin(request);
    const { user } = await currentUserFromRequest(request);
    if (!user) {
      return NextResponse.json({ error: "Sign in to continue.", code: "UNAUTHENTICATED" }, { status: 401 });
    }
    if (user.role !== "ADMIN") {
      return NextResponse.json({ error: "This action requires shop administrator permission.", code: "FORBIDDEN" }, { status: 403 });
    }
    const contentLength = Number(request.headers.get("content-length") ?? 0);
    if (contentLength > MAX_FILE_SIZE + 64 * 1024) {
      return NextResponse.json({ error: "Images must be 5 MB or smaller.", code: "FILE_TOO_LARGE" }, { status: 413 });
    }
    const reader = request.body?.getReader();
    const chunks: Uint8Array[] = [];
    let totalBytes = 0;
    if (reader) {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        totalBytes += value.byteLength;
        if (totalBytes > MAX_FILE_SIZE + 64 * 1024) {
          await reader.cancel();
          return NextResponse.json({ error: "Images must be 5 MB or smaller.", code: "FILE_TOO_LARGE" }, { status: 413 });
        }
        chunks.push(value);
      }
      reader.releaseLock();
    }
    const headers = new Headers(request.headers);
    headers.delete("content-length");
    headers.delete("transfer-encoding");
    const boundedRequest = new Request(request.url, {
      method: "POST",
      headers,
      body: Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))),
    });
    let form: FormData;
    try {
      form = await boundedRequest.formData();
    } catch {
      return NextResponse.json({ error: "Send a valid image upload form.", code: "VALIDATION_ERROR" }, { status: 400 });
    }
    const file = form.get("file");
    const productId = form.get("productId");
    if (!(file instanceof File) || typeof productId !== "string") {
      return NextResponse.json({ error: "Choose an image and product.", code: "VALIDATION_ERROR" }, { status: 400 });
    }
    if (file.size < 1 || file.size > MAX_FILE_SIZE) {
      return NextResponse.json({ error: "Images must be between 1 byte and 5 MB.", code: "FILE_TOO_LARGE" }, { status: 413 });
    }
    const product = await prisma.product.findUnique({
      where: { id: productId },
      select: { id: true, name: true },
    });
    if (!product) {
      return NextResponse.json({ error: "Product not found.", code: "NOT_FOUND" }, { status: 404 });
    }
    const buffer = Buffer.from(await file.arrayBuffer());
    const signature = signatures.find((candidate) =>
      candidate.bytes.every((byte, index) => byte === -1 || buffer[index] === byte),
    );
    if (!signature) {
      return NextResponse.json({ error: "Use a valid JPEG, PNG or WebP image.", code: "INVALID_FILE_TYPE" }, { status: 415 });
    }
    const filename = `${randomUUID()}.${signature.extension}`;
    const url = `/uploads/${filename}`;
    await prisma.productImage.create({
      data: {
        productId,
        url,
        altText: file.name.slice(0, 200) || product.name,
        sortOrder: 0,
        data: buffer,
      },
    });
    return NextResponse.json({ url, mimeType: signature.mime }, { status: 201 });
  } catch (error) {
    console.error("Product image upload failed.", error);
    return NextResponse.json({ error: "The image could not be saved.", code: "UPLOAD_FAILED" }, { status: 500 });
  }
}
