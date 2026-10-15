UPDATE "Product"
SET "mrp" = NULL,
    "offerPrice" = NULL,
    "price" = 0
WHERE "priceMode" = 'QUOTE';

ALTER TABLE "Product"
ADD CONSTRAINT "Product_mrp_positive_check"
CHECK ("mrp" IS NULL OR "mrp" > 0),
ADD CONSTRAINT "Product_offer_price_below_mrp_check"
CHECK (
  "offerPrice" IS NULL
  OR (
    "mrp" IS NOT NULL
    AND "offerPrice" > 0
    AND "offerPrice" < "mrp"
  )
);
