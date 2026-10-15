import { readFile } from "node:fs/promises";
import path from "node:path";
import { prisma } from "@/lib/db";

const contentTypes: Record<string, string> = {
  jpg: "image/jpeg",
  png: "image/png",
  webp: "image/webp",
};

export async function GET(
  _request: Request,
  context: RouteContext<"/uploads/[filename]">,
) {
  const { filename } = await context.params;
  if (!/^[a-f0-9-]{36}\.(?:jpg|png|webp)$/i.test(filename)) {
    return new Response("Not found", { status: 404 });
  }

  const url = `/uploads/${filename}`;
  const image = await prisma.productImage.findFirst({
    where: { url },
    select: { data: true },
  });
  if (image?.data) {
    const extension = filename.split(".").pop()?.toLowerCase() ?? "";
    return new Response(new Uint8Array(image.data), {
      headers: {
        "content-type": contentTypes[extension],
        "cache-control": "public, max-age=31536000, immutable",
        "x-content-type-options": "nosniff",
      },
    });
  }

  try {
    const legacyPath = path.join(process.cwd(), "public", "uploads", filename);
    const file = await readFile(legacyPath);
    const extension = filename.split(".").pop()?.toLowerCase() ?? "";
    return new Response(new Uint8Array(file), {
      headers: {
        "content-type": contentTypes[extension],
        "cache-control": "public, max-age=31536000, immutable",
        "x-content-type-options": "nosniff",
      },
    });
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
      return new Response("Not found", { status: 404 });
    }
    throw error;
  }
}
