ALTER TABLE "Product"
ADD COLUMN "mrp" INTEGER,
ADD COLUMN "offerPrice" INTEGER;

UPDATE "Product"
SET "mrp" = "price"
WHERE "price" > 0;
