export type CartLine = {
  productId: string;
  quantity: number;
};

export type RequestStatus =
  | "REQUESTED"
  | "REVIEWING"
  | "AWAITING_BUYER_CONFIRMATION"
  | "AWAITING_PAYMENT"
  | "PAYMENT_VERIFIED"
  | "READY_TO_DISPATCH"
  | "DISPATCHED"
  | "DELIVERED"
  | "CANCELLED";

export const CART_KEY = "ncm-request-cart";

export function formatPrice(value: number) {
  return new Intl.NumberFormat("en-IN", {
    style: "currency",
    currency: "INR",
    maximumFractionDigits: 0,
  }).format(value);
}

export function statusLabel(status: RequestStatus) {
  return {
    REQUESTED: "Request received",
    REVIEWING: "Being reviewed",
    AWAITING_BUYER_CONFIRMATION: "Awaiting your confirmation",
    AWAITING_PAYMENT: "Awaiting payment",
    PAYMENT_VERIFIED: "Payment verified",
    READY_TO_DISPATCH: "Ready to dispatch",
    DISPATCHED: "On its way",
    DELIVERED: "Delivered",
    CANCELLED: "Cancelled",
  }[status];
}
