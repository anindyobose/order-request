import ExcelJS from "exceljs";
import { describe, expect, it } from "vitest";
import {
  createProductImportTemplate,
  parseProductImport,
  ProductImportError,
} from "./product-import";
import { getDiscountPercent } from "./product-pricing";

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
  "image",
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
        mrp: 12500,
        offerPrice: null,
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

  it("maps an embedded JPEG or PNG picture in the Image column to its product row", async () => {
    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet("Products");
    sheet.addRow(headers);
    sheet.addRow(row);
    const png = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jk0QAAAAASUVORK5CYII=",
      "base64",
    );
    const imageId = workbook.addImage({ base64: png.toString("base64"), extension: "png" });
    sheet.addImage(imageId, { tl: { col: 11, row: 1 }, ext: { width: 60, height: 60 } });

    const products = await parseProductImport(Buffer.from(await workbook.xlsx.writeBuffer()), "xlsx");
    expect(products[0].image).toMatchObject({
      extension: "png",
      mimeType: "image/png",
      buffer: png,
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

  it("downloads a populated Excel catalog that can be re-uploaded without changing its products", async () => {
    const product = {
      sku: "NCM-TEST-001",
      slug: "test-instrument",
      name: "Test Instrument",
      description: "A test instrument",
      category: "Strings",
      brand: "Test Brand",
      price: 15000,
      mrp: 20000,
      offerPrice: 15000,
      priceMode: "FIXED" as const,
      stockStatus: "IN_STOCK" as const,
      active: true,
      archived: false,
      sortOrder: 3,
      images: [{ url: "/uploads/test-image.png" }],
    };
    const xlsx = await createProductImportTemplate([product], "xlsx");
    const csv = await createProductImportTemplate([product], "csv");

    const expected = [{
      sku: product.sku,
      slug: product.slug,
      name: product.name,
      description: product.description,
      category: product.category,
      brand: product.brand,
      price: 15000,
      mrp: 20000,
      offerPrice: 15000,
      priceMode: "FIXED",
      stockStatus: "IN_STOCK",
      active: true,
      archived: false,
      sortOrder: 3,
      imageReference: "/uploads/test-image.png",
    }];
    await expect(parseProductImport(xlsx, "xlsx")).resolves.toEqual(expected);
    await expect(parseProductImport(csv, "csv")).resolves.toEqual(expected);
  });

  it("supports legacy price imports and validates offer prices against MRP", async () => {
    const legacyCsv = [
      "sku,slug,name,description,category,price,priceMode,stockStatus,active",
      "NCM-LEGACY-001,legacy-instrument,Legacy Instrument,A legacy product,Strings,9000,FIXED,IN_STOCK,true",
    ].join("\n");
    await expect(parseProductImport(Buffer.from(legacyCsv), "csv")).resolves.toMatchObject([
      { price: 9000, mrp: 9000, offerPrice: null },
    ]);

    const badOfferCsv = [
      "sku,slug,name,description,category,mrp,offerPrice,priceMode,stockStatus,active",
      "NCM-TEST-001,test-instrument,Test Instrument,A test product,Strings,10000,10000,FIXED,IN_STOCK,true",
    ].join("\n");
    await expect(parseProductImport(Buffer.from(badOfferCsv), "csv")).rejects.toThrow(
      "offerPrice must be greater than zero and lower than MRP",
    );
  });

  it("calculates a rounded whole-number offer discount", () => {
    expect(getDiscountPercent(20000, 15000)).toBe(25);
    expect(getDiscountPercent(999, 500)).toBe(50);
    expect(getDiscountPercent(1000, 999)).toBe(1);
    expect(getDiscountPercent(1000, 1000)).toBeNull();
    expect(getDiscountPercent(null, 500)).toBeNull();
  });
});
