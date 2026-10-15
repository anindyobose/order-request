UPDATE "Product"
SET "mrp" = "price"
WHERE "priceMode" = 'FIXED'
  AND "mrp" IS NULL
  AND "price" > 0;
