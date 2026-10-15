import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { currentUserFromRequest } from "@/lib/auth";
import { createProductImportTemplate } from "@/lib/product-import";

export async function GET(request: Request) {
  const { user } = await currentUserFromRequest(request);
  if (!user) return NextResponse.json({ error: "Sign in to continue." }, { status: 401 });
  if (user.role !== "ADMIN") {
    return NextResponse.json({ error: "This action requires shop administrator permission." }, { status: 403 });
  }

  const format = new URL(request.url).searchParams.get("format") ?? "xlsx";
  if (format !== "xlsx" && format !== "csv") {
    return NextResponse.json({ error: "Choose the xlsx or csv template format." }, { status: 400 });
  }
  const products = await prisma.product.findMany({
    include: {
      images: {
        select: { url: true },
        orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }],
        take: 1,
      },
    },
    orderBy: [{ sortOrder: "asc" }, { name: "asc" }],
  });
  const content = await createProductImportTemplate(products, format);
  const today = new Date().toISOString().slice(0, 10);
  const filename = `product-catalog-${today}.${format}`;
  return new Response(content, {
    headers: {
      "Content-Type": format === "xlsx"
        ? "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
        : "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="${filename}"`,
      "Cache-Control": "private, no-store",
    },
  });
}
