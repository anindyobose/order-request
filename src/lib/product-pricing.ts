export function getDiscountPercent(mrp: number | null, offerPrice: number | null) {
  if (mrp === null || offerPrice === null || mrp <= 0 || offerPrice <= 0 || offerPrice >= mrp) {
    return null;
  }
  return Math.max(1, Math.round(((mrp - offerPrice) / mrp) * 100));
}
