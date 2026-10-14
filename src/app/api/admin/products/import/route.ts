import { randomUUID } from "node:crypto";
import { mkdir, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { NextResponse } from "next/server";
import { Prisma } from "@prisma/client";
import { currentUserFromRequest } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { parseProductImport, ProductImportError } from "@/lib/product-import";
import { assertSameOrigin } from "@/lib/security";

const MAX_UPLOAD_BYTES = 5 * 1024 * 1024;
const MAX_FORM_OVERHEAD_BYTES = 64 * 1024;

function errorResponse(message: string, status: number) {
  return NextResponse.json({ error: message }, { status });
}

async function removeUploadedFiles(paths: string[]) {
  for (const filePath of paths) {
    try {
      await unlink(filePath);
    } catch (error) {
      if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") continue;
      console.error("Could not remove a product image after import.", error);
    }
  }
}

export async function POST(request: Request) {
  try {
    assertSameOrigin(request);
    const { user } = await currentUserFromRequest(request);
    if (!user) return errorResponse("Sign in to continue.", 401);
    if (user.role !== "ADMIN") return errorResponse("This action requires shop administrator permission.", 403);

    const contentLength = Number(request.headers.get("content-length") ?? 0);
    if (contentLength > MAX_UPLOAD_BYTES + MAX_FORM_OVERHEAD_BYTES) {
      return errorResponse("Spreadsheet files must be 5 MB or smaller.", 413);
    }
    const reader = request.body?.getReader();
    const chunks: Uint8Array[] = [];
    let totalBytes = 0;
    if (reader) {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        totalBytes += value.byteLength;
        if (totalBytes > MAX_UPLOAD_BYTES + MAX_FORM_OVERHEAD_BYTES) {
          await reader.cancel();
          return errorResponse("Spreadsheet files must be 5 MB or smaller.", 413);
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
      return errorResponse("Send a valid spreadsheet upload form.", 400);
    }

    const file = form.get("file");
    if (!(file instanceof File)) return errorResponse("Choose an .xlsx or .csv product file.", 400);
    if (file.size < 1 || file.size > MAX_UPLOAD_BYTES) {
      return errorResponse("Spreadsheet files must be between 1 byte and 5 MB.", 413);
    }
    const extension = file.name.toLowerCase().split(".").pop();
    if (extension !== "xlsx" && extension !== "csv") {
      return errorResponse("Use an .xlsx Excel workbook or .csv file.", 415);
    }

    const bytes = Buffer.from(await file.arrayBuffer());
    if (extension === "xlsx" && (bytes[0] !== 0x50 || bytes[1] !== 0x4b)) {
      return errorResponse("The .xlsx file does not have a valid Excel workbook signature.", 415);
    }
    if (extension === "csv") {
      try {
        new TextDecoder("utf-8", { fatal: true }).decode(bytes);
      } catch {
        return errorResponse("CSV files must use UTF-8 text encoding.", 400);
      }
    }

    const products = await parseProductImport(bytes, extension);
    const skuList = products.map((product) => product.sku);
    const slugList = products.map((product) => product.slug);
    const [existingSkus, existingSlugs] = await Promise.all([
      prisma.product.findMany({
        where: { sku: { in: skuList } },
        select: { sku: true },
      }),
      prisma.product.findMany({
        where: { slug: { in: slugList } },
        select: { sku: true, slug: true },
      }),
    ]);
    const incomingBySlug = new Map(products.map((product) => [product.slug, product.sku]));
    const slugConflicts = existingSlugs.filter(
      (existing) => incomingBySlug.has(existing.slug) && incomingBySlug.get(existing.slug) !== existing.sku,
    );
    if (slugConflicts.length) {
      return errorResponse(
        `Slug "${slugConflicts[0].slug}" is already used by a different product. Change the slug or SKU in the spreadsheet.`,
        409,
      );
    }

    const existingSkuSet = new Set(existingSkus.map((product) => product.sku));
    const imageUrls = new Map<string, string>();
    const savedImagePaths: string[] = [];
    const removedImagePaths: string[] = [];
    const uploadDirectory = path.join(process.cwd(), "public", "uploads");
    try {
      for (const product of products) {
        if (!product.image) continue;
        await mkdir(uploadDirectory, { recursive: true });
        const filename = `${randomUUID()}.${product.image.extension}`;
        const filePath = path.join(uploadDirectory, filename);
        await writeFile(filePath, product.image.buffer, { flag: "wx" });
        savedImagePaths.push(filePath);
        imageUrls.set(product.sku, `/uploads/${filename}`);
      }

      await prisma.$transaction(async (tx) => {
        for (const product of products) {
          const { image, ...productData } = product;
          if (image && !imageUrls.has(product.sku)) {
            throw new Error(`Image for product ${product.sku} was not saved before the database update.`);
          }
          await tx.product.upsert({
            where: { sku: product.sku },
            create: productData,
            update: productData,
          });
          const imageUrl = imageUrls.get(product.sku);
          if (!imageUrl) continue;
          const savedProduct = await tx.product.findUniqueOrThrow({
            where: { sku: product.sku },
            select: {
              id: true,
              images: { orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }] },
            },
          });
          const primaryImage = savedProduct.images[0];
          if (primaryImage) {
            const match = /^\/uploads\/([a-f0-9-]+\.(?:jpg|png|webp))$/i.exec(primaryImage.url);
            if (match) removedImagePaths.push(path.join(uploadDirectory, match[1]));
            await tx.productImage.update({
              where: { id: primaryImage.id },
              data: { url: imageUrl, altText: product.name, sortOrder: 0 },
            });
          } else {
            await tx.productImage.create({
              data: {
                productId: savedProduct.id,
                url: imageUrl,
                altText: product.name,
                sortOrder: 0,
              },
            });
          }
        }
      }, { maxWait: 5_000, timeout: 30_000 });
    } catch (error) {
      await removeUploadedFiles(savedImagePaths);
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
        return errorResponse("A product SKU or slug conflicts with another catalog item. No rows were imported.", 409);
      }
      throw error;
    }
    await removeUploadedFiles(removedImagePaths);

    const updated = products.filter((product) => existingSkuSet.has(product.sku)).length;
    return NextResponse.json({
      created: products.length - updated,
      updated,
      total: products.length,
    });
  } catch (error) {
    if (error instanceof ProductImportError) return errorResponse(error.message, 400);
    console.error("Product spreadsheet import failed.", error);
    return errorResponse("The product spreadsheet could not be imported.", 500);
  }
}
