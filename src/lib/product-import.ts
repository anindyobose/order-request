import ExcelJS from "exceljs";
import { Readable } from "node:stream";

export const PRODUCT_IMPORT_MAX_ROWS = 1000;
export const PRODUCT_IMPORT_COLUMNS = [
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
] as const;

export type ImportedProductImage = {
  buffer: Buffer;
  extension: "jpg" | "png";
  mimeType: "image/jpeg" | "image/png";
};

export type ImportedProduct = {
  sku: string;
  slug: string;
  name: string;
  description: string;
  category: string;
  brand: string | null;
  price: number;
  priceMode: "FIXED" | "QUOTE";
  stockStatus: "IN_STOCK" | "LIMITED" | "OUT_OF_STOCK";
  active: boolean;
  sortOrder: number;
  image?: ImportedProductImage;
};

export class ProductImportError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProductImportError";
  }
}

function cellText(value: ExcelJS.CellValue): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return String(value).trim();
  }
  throw new ProductImportError("Formula, rich-text, and linked cells are not supported. Use plain values.");
}

function requiredText(
  value: string,
  field: string,
  rowNumber: number,
  maxLength: number,
): string {
  if (!value) throw new ProductImportError(`Row ${rowNumber}: ${field} is required.`);
  if (value.length > maxLength) {
    throw new ProductImportError(`Row ${rowNumber}: ${field} must be ${maxLength} characters or fewer.`);
  }
  return value;
}

function parseBoolean(value: string, rowNumber: number): boolean {
  switch (value.toLowerCase()) {
    case "true":
    case "yes":
    case "1":
      return true;
    case "false":
    case "no":
    case "0":
      return false;
    default:
      throw new ProductImportError(`Row ${rowNumber}: active must be true/false, yes/no, or 1/0.`);
  }
}

function parseInteger(value: string, field: string, rowNumber: number, fallback?: number): number {
  if (!value && fallback !== undefined) return fallback;
  if (!/^\d+$/.test(value)) {
    throw new ProductImportError(`Row ${rowNumber}: ${field} must be a non-negative whole number.`);
  }
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number > 100_000_000) {
    throw new ProductImportError(`Row ${rowNumber}: ${field} is outside the supported range.`);
  }
  return number;
}

function normalizeHeader(value: string) {
  return value.replace(/^\uFEFF/, "").trim().toLowerCase().replace(/[\s_-]+/g, "");
}

export async function parseProductImport(
  bytes: Buffer,
  format: "csv" | "xlsx",
): Promise<ImportedProduct[]> {
  const workbook = new ExcelJS.Workbook();
  try {
    const input = Readable.from([Buffer.from(bytes)]);
    if (format === "xlsx") await workbook.xlsx.read(input);
    else await workbook.csv.read(input);
  } catch {
    throw new ProductImportError("The spreadsheet could not be read. Check that it is a valid .xlsx or .csv file.");
  }

  const sheet = workbook.worksheets[0];
  if (!sheet) throw new ProductImportError("The spreadsheet must contain a worksheet.");
  if (sheet.rowCount > PRODUCT_IMPORT_MAX_ROWS + 1 || sheet.columnCount > PRODUCT_IMPORT_COLUMNS.length) {
    throw new ProductImportError(`Import at most ${PRODUCT_IMPORT_MAX_ROWS} product rows and ${PRODUCT_IMPORT_COLUMNS.length} columns.`);
  }

  const headerRow = sheet.getRow(1);
  const columns = new Map<string, number>();
  for (let column = 1; column <= sheet.columnCount; column += 1) {
    const rawHeader = cellText(headerRow.getCell(column).value);
    if (!rawHeader) continue;
    const header = normalizeHeader(rawHeader);
    if (!PRODUCT_IMPORT_COLUMNS.some((candidate) => normalizeHeader(candidate) === header)) {
      throw new ProductImportError(`Unsupported column "${rawHeader}". Use the provided product import template.`);
    }
    if (columns.has(header)) throw new ProductImportError(`The column "${rawHeader}" appears more than once.`);
    columns.set(header, column);
  }

  const requiredColumns = ["sku", "slug", "name", "description", "category", "price", "priceMode", "stockStatus", "active"];
  const missing = requiredColumns.filter((header) => !columns.has(normalizeHeader(header)));
  if (missing.length) {
    throw new ProductImportError(`Missing required columns: ${missing.join(", ")}. Download the product import template.`);
  }

  const imageColumn = columns.get(normalizeHeader("image"));
  const embeddedImages = new Map<number, ImportedProductImage>();
  if (format === "xlsx") {
    for (const embedded of sheet.getImages()) {
      const column = Math.floor(embedded.range.tl.col) + 1;
      const rowNumber = Math.floor(embedded.range.tl.row) + 1;
      if (!imageColumn || column !== imageColumn) {
        throw new ProductImportError(`Row ${rowNumber}: place product pictures in the Image column.`);
      }
      if (rowNumber < 2 || rowNumber > sheet.rowCount) {
        throw new ProductImportError("Place every embedded picture inside its product row in the Image column.");
      }
      if (embeddedImages.has(rowNumber)) {
        throw new ProductImportError(`Row ${rowNumber}: add no more than one product image per row.`);
      }
      const imageId = Number(embedded.imageId);
      if (!Number.isSafeInteger(imageId)) {
        throw new ProductImportError(`Row ${rowNumber}: the embedded picture could not be read.`);
      }
      const image = workbook.getImage(imageId);
      const buffer = image.buffer
        ? Buffer.from(image.buffer)
        : image.base64
          ? Buffer.from(image.base64, "base64")
          : null;
      if (!buffer?.length) {
        throw new ProductImportError(`Row ${rowNumber}: the embedded picture is empty or unreadable.`);
      }
      let extension: ImportedProductImage["extension"];
      let mimeType: ImportedProductImage["mimeType"];
      if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
        extension = "jpg";
        mimeType = "image/jpeg";
      } else if (buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
        extension = "png";
        mimeType = "image/png";
      } else {
        throw new ProductImportError(`Row ${rowNumber}: embedded pictures must be JPEG or PNG.`);
      }
      if (buffer.length > 5 * 1024 * 1024) {
        throw new ProductImportError(`Row ${rowNumber}: each product image must be 5 MB or smaller.`);
      }
      embeddedImages.set(rowNumber, { buffer, extension, mimeType });
    }
  }

  const imported: ImportedProduct[] = [];
  const seenSkus = new Set<string>();
  const seenSlugs = new Set<string>();
  const errors: string[] = [];

  for (let rowNumber = 2; rowNumber <= sheet.rowCount; rowNumber += 1) {
    const row = sheet.getRow(rowNumber);
    const values = new Map<string, string>();
    let hasValue = false;
    try {
      for (const [header, column] of columns) {
        const value = cellText(row.getCell(column).value);
        if (header === normalizeHeader("image") && value) {
          throw new ProductImportError(`Row ${rowNumber}: add pictures as embedded images in the Image column, not as a URL or filename.`);
        }
        values.set(header, value);
        if (value) hasValue = true;
      }
      if (!hasValue) continue;

      const get = (header: string) => values.get(normalizeHeader(header)) ?? "";
      const sku = requiredText(get("sku"), "sku", rowNumber, 80);
      const slug = requiredText(get("slug"), "slug", rowNumber, 120).toLowerCase();
      const name = requiredText(get("name"), "name", rowNumber, 160);
      const description = requiredText(get("description"), "description", rowNumber, 5000);
      const category = requiredText(get("category"), "category", rowNumber, 100);
      const brand = get("brand");
      if (brand.length > 100) throw new ProductImportError(`Row ${rowNumber}: brand must be 100 characters or fewer.`);
      if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug)) {
        throw new ProductImportError(`Row ${rowNumber}: slug must contain lowercase letters, numbers, and hyphens.`);
      }
      if (seenSkus.has(sku)) throw new ProductImportError(`Row ${rowNumber}: duplicate SKU "${sku}".`);
      if (seenSlugs.has(slug)) throw new ProductImportError(`Row ${rowNumber}: duplicate slug "${slug}".`);
      seenSkus.add(sku);
      seenSlugs.add(slug);

      const priceMode = get("priceMode").toUpperCase();
      if (priceMode !== "FIXED" && priceMode !== "QUOTE") {
        throw new ProductImportError(`Row ${rowNumber}: priceMode must be FIXED or QUOTE.`);
      }
      const stockStatus = get("stockStatus").toUpperCase();
      if (!["IN_STOCK", "LIMITED", "OUT_OF_STOCK"].includes(stockStatus)) {
        throw new ProductImportError(`Row ${rowNumber}: stockStatus must be IN_STOCK, LIMITED, or OUT_OF_STOCK.`);
      }

      imported.push({
        sku,
        slug,
        name,
        description,
        category,
        brand: brand || null,
        price: parseInteger(get("price"), "price", rowNumber),
        priceMode,
        stockStatus: stockStatus as ImportedProduct["stockStatus"],
        active: parseBoolean(get("active"), rowNumber),
        sortOrder: parseInteger(get("sortOrder"), "sortOrder", rowNumber, 0),
        ...(embeddedImages.has(rowNumber) ? { image: embeddedImages.get(rowNumber)! } : {}),
      });
    } catch (error) {
      if (!(error instanceof ProductImportError)) throw error;
      errors.push(error.message);
      if (errors.length >= 20) break;
    }
  }

  if (!imported.length && !errors.length) {
    throw new ProductImportError("The spreadsheet contains no product rows.");
  }
  if (errors.length) {
    throw new ProductImportError(`${errors.join("\n")}${errors.length === 20 ? "\nOnly the first 20 errors are shown." : ""}`);
  }
  return imported;
}
