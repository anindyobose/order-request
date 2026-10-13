import ExcelJS from "exceljs";
import { describe, expect, it } from "vitest";
import { parseProductImport, ProductImportError } from "./product-import";

const headers = [
  "sku",
  "slug",
  "name",
  "description",
  "category",
  "brand",
  "price",
  "priceMode",
  "stockStatus",
  "active",
  "sortOrder",
];

const row = [
  "NCM-TEST-001",
  "test-instrument",
  "Test Instrument",
  "A test product",
  "Strings",
  "Test Brand",
  12500,
  "FIXED",
  "IN_STOCK",
  true,
  2,
];

describe("product spreadsheet imports", () => {
  it("parses CSV and applies defaults for optional fields", async () => {
    const csv = [
      "\uFEFFSKU,Slug,Name,Description,Category,Price,Price Mode,Stock Status,Active",
      "NCM-TEST-001,test-instrument,Test Instrument,A test product,Strings,12500,FIXED,IN_STOCK,yes",
    ].join("\n");

    await expect(parseProductImport(Buffer.from(csv), "csv")).resolves.toEqual([
      {
        sku: "NCM-TEST-001",
        slug: "test-instrument",
        name: "Test Instrument",
        description: "A test product",
        category: "Strings",
        brand: null,
        price: 12500,
        priceMode: "FIXED",
        stockStatus: "IN_STOCK",
        active: true,
        sortOrder: 0,
      },
    ]);
  });

  it("reads an Excel workbook and accepts common enum casing", async () => {
    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet("Products");
    sheet.addRow(headers);
    sheet.addRow([...row.slice(0, 7), "quote", "limited", "false", 2]);
    const bytes = Buffer.from(await workbook.xlsx.writeBuffer());

    const products = await parseProductImport(bytes, "xlsx");
    expect(products[0]).toMatchObject({
      priceMode: "QUOTE",
      stockStatus: "LIMITED",
      active: false,
    });
  });

  it("rejects duplicate SKUs before any product rows can be written", async () => {
    const csv = [
      headers.join(","),
      row.join(","),
      [...row.slice(0, 1), "another-slug", ...row.slice(2)].join(","),
    ].join("\n");

    await expect(parseProductImport(Buffer.from(csv), "csv")).rejects.toThrow(
      'Row 3: duplicate SKU "NCM-TEST-001".',
    );
  });

  it("rejects invalid product values and formula cells", async () => {
    const badPrice = [...row];
    badPrice[6] = -1;
    await expect(
      parseProductImport(Buffer.from([headers.join(","), badPrice.join(",")].join("\n")), "csv"),
    ).rejects.toThrow("price must be a non-negative whole number");

    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet("Products");
    sheet.addRow(headers);
    sheet.addRow(row);
    sheet.getCell("C2").value = { formula: 'HYPERLINK("https://example.invalid","Product")' };
    const bytes = Buffer.from(await workbook.xlsx.writeBuffer());
    await expect(parseProductImport(bytes, "xlsx")).rejects.toBeInstanceOf(ProductImportError);
  });
});
