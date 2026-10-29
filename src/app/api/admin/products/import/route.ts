import { randomUUID } from "node:crypto";
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

    // Auto-generated slugs keep an existing product's URL, and otherwise avoid slugs already in the catalog.
    const generated = products.filter((product) => product.slugGenerated);
    if (generated.length) {
      const [knownBySku, takenRows] = await Promise.all([
        prisma.product.findMany({
          where: { sku: { in: generated.map((product) => product.sku) } },
          select: { sku: true, slug: true },
        }),
        prisma.product.findMany({
          where: { OR: generated.map((product) => ({ slug: { startsWith: product.slug } })) },
          select: { sku: true, slug: true },
        }),
      ]);
      const slugBySku = new Map(knownBySku.map((product) => [product.sku, product.slug]));
      const used = new Set(products.filter((product) => !product.slugGenerated).map((product) => product.slug));
      for (const product of generated) {
        const existingSlug = slugBySku.get(product.sku);
        if (existingSlug) {
          product.slug = existingSlug;
          used.add(existingSlug);
        }
      }
      for (const product of generated) {
        if (slugBySku.has(product.sku)) continue;
        const base = product.slug;
        let candidate = base;
        for (let suffix = 2; used.has(candidate) || takenRows.some((row) => row.slug === candidate); suffix += 1) {
          candidate = `${base}-${suffix}`;
        }
        product.slug = candidate;
        used.add(candidate);
      }
    }
    const slugList = products.map((product) => product.slug);
    const [existingProducts, existingSlugs] = await Promise.all([
      prisma.product.findMany({
        where: { sku: { in: skuList } },
        select: {
          sku: true,
          slug: true,
          name: true,
          description: true,
          category: true,
          brand: true,
          price: true,
          mrp: true,
          offerPrice: true,
          priceMode: true,
          stockStatus: true,
          active: true,
          archived: true,
          sortOrder: true,
          images: {
            select: { url: true },
            orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }],
            take: 1,
          },
        },
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

    const existingBySku = new Map(existingProducts.map((product) => [product.sku, product]));
    for (const product of products) {
      if (
        product.imageReference &&
        !product.image &&
        existingBySku.get(product.sku)?.images[0]?.url !== product.imageReference
      ) {
        return errorResponse(
          `Row for SKU "${product.sku}": the image reference is informational. To change the image, embed a JPEG or PNG in the Image column.`,
          400,
        );
      }
    }
    const unchangedProducts = products.filter((product) => {
      const existing = existingBySku.get(product.sku);
      return existing &&
        !product.image &&
        existing.slug === product.slug &&
        existing.name === product.name &&
        existing.description === product.description &&
        existing.category === product.category &&
        existing.brand === product.brand &&
        existing.price === product.price &&
        existing.mrp === product.mrp &&
        existing.offerPrice === product.offerPrice &&
        existing.priceMode === product.priceMode &&
        existing.stockStatus === product.stockStatus &&
        existing.active === product.active &&
        (product.archived === undefined || existing.archived === product.archived) &&
        existing.sortOrder === product.sortOrder;
    });
    const unchangedSkus = new Set(unchangedProducts.map((product) => product.sku));
    const productsToSave = products.filter((product) => !unchangedSkus.has(product.sku));
    const imageUrls = new Map<string, string>();
    try {
      for (const product of productsToSave) {
        if (!product.image) continue;
        const filename = `${randomUUID()}.${product.image.extension}`;
        imageUrls.set(product.sku, `/uploads/${filename}`);
      }

      await prisma.$transaction(async (tx) => {
        for (const product of productsToSave) {
          const { image } = product;
          if (image && !imageUrls.has(product.sku)) {
            throw new Error(`Image for product ${product.sku} was not saved before the database update.`);
          }
          const productData = {
            sku: product.sku,
            slug: product.slug,
            name: product.name,
            description: product.description,
            category: product.category,
            brand: product.brand,
            price: product.price,
            mrp: product.mrp,
            offerPrice: product.offerPrice,
            priceMode: product.priceMode,
            stockStatus: product.stockStatus,
            active: product.active,
            sortOrder: product.sortOrder,
            ...(product.archived !== undefined ? { archived: product.archived } : {}),
          };
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
            await tx.productImage.update({
              where: { id: primaryImage.id },
              data: {
                url: imageUrl,
                altText: product.name,
                sortOrder: 0,
                data: image ? Uint8Array.from(image.buffer) : undefined,
              },
            });
          } else {
            await tx.productImage.create({
              data: {
                productId: savedProduct.id,
                url: imageUrl,
                altText: product.name,
                sortOrder: 0,
                data: image ? Uint8Array.from(image.buffer) : undefined,
              },
            });
          }
        }
      }, { maxWait: 5_000, timeout: 30_000 });
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
        return errorResponse("A product SKU or slug conflicts with another catalog item. No rows were imported.", 409);
      }
      throw error;
    }

    const created = products.filter((product) => !existingBySku.has(product.sku)).length;
    const updated = productsToSave.length - created;
    return NextResponse.json({
      created,
      updated,
      total: products.length,
      unchanged: unchangedProducts.length,
    });
  } catch (error) {
    if (error instanceof ProductImportError) return errorResponse(error.message, 400);
    console.error("Product spreadsheet import failed.", error);
    return errorResponse("The product spreadsheet could not be imported.", 500);
  }
}
