export type GqlError = Error & { code?: string };

type GraphqlResponse<T> = {
  data?: T;
  errors?: Array<{
    message: string;
    extensions?: { code?: string };
  }>;
};

export async function graphqlRequest<T>(
  query: string,
  variables: Record<string, unknown> = {},
): Promise<T> {
  const response = await fetch("/api/graphql", {
    method: "POST",
    credentials: "same-origin",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ query, variables }),
    cache: "no-store",
  });
  const result = (await response.json()) as GraphqlResponse<T>;
  if (!response.ok) {
    const error = new Error(
      result.errors?.[0]?.message ?? "The shop service is temporarily unavailable.",
    ) as GqlError;
    error.code = result.errors?.[0]?.extensions?.code;
    throw error;
  }
  if (result.errors?.length) {
    const firstError = result.errors[0];
    const error = new Error(firstError.message) as GqlError;
    error.code = firstError.extensions?.code;
    throw error;
  }
  if (!result.data) throw new Error("The shop service returned an empty response.");
  return result.data;
}

export type SessionUser = {
  id: string;
  name: string;
  email: string | null;
  phone: string | null;
  role: "BUYER" | "ORDER_OPERATOR" | "ADMIN";
  status?: "ACTIVE" | "DISABLED";
};

export type Address = {
  id: string;
  recipientName: string;
  phone: string;
  line1: string;
  line2: string | null;
  city: string;
  state: string;
  postalCode: string;
  isDefault: boolean;
  createdAt?: string;
  updatedAt?: string;
};

export type CatalogProduct = {
  id: string;
  sku: string;
  slug: string;
  name: string;
  description: string;
  category: string;
  brand: string | null;
  price: number;
  mrp: number | null;
  offerPrice: number | null;
  priceMode: "FIXED" | "QUOTE";
  stockStatus: "IN_STOCK" | "LIMITED" | "OUT_OF_STOCK";
  active: boolean;
  archived: boolean;
  sortOrder: number;
  images: Array<{ id: string; url: string; altText: string; sortOrder: number }>;
};

export type OrderStatus =
  | "REQUESTED"
  | "REVIEWING"
  | "AWAITING_BUYER_CONFIRMATION"
  | "AWAITING_PAYMENT"
  | "PAYMENT_VERIFIED"
  | "READY_TO_DISPATCH"
  | "DISPATCHED"
  | "DELIVERED"
  | "CANCELLED";

export type Order = {
  id: string;
  orderNumber: string;
  status: OrderStatus;
  paymentStatus: "NOT_DUE" | "PENDING" | "PARTIALLY_PAID" | "VERIFIED" | "REFUND_PENDING" | "REFUNDED";
  subtotal: number;
  deliveryFee: number;
  discount: number;
  finalAmount: number | null;
  buyerNotes: string | null;
  termsMessage?: string | null;
  cancellationReason?: string | null;
  createdAt: string;
  updatedAt: string;
  termsConfirmedAt: string | null;
  termsBuyerAcceptedAt: string | null;
  internalNotes?: string | null;
  customer: {
    id: string;
    name: string;
    email: string | null;
    phone: string | null;
  };
  address: {
    recipientName: string;
    phone: string;
    line1: string;
    line2: string | null;
    city: string;
    state: string;
    postalCode: string;
  };
  items: Array<{
    id: string;
    sku: string;
    name: string;
    priceMode: "FIXED" | "QUOTE";
    requestedQuantity: number;
    quantity: number;
    requestedUnitPrice: number | null;
    agreedUnitPrice: number | null;
    agreedVariant: string | null;
  }>;
  shipments: Array<{
    courier: string;
    trackingNumber: string | null;
    notes: string | null;
    dispatchedAt: string;
    deliveredAt: string | null;
  }>;
  paymentRecords?: Array<{
    id: string;
    amount: number;
    method: string;
    reference: string | null;
    verifiedAt: string | null;
    createdAt: string;
  }>;
};

export const PRODUCT_FIELDS = `
  id sku slug name description category brand price mrp offerPrice priceMode stockStatus active archived sortOrder
  images { id url altText sortOrder }
`;

export const ORDER_FIELDS = `
  id orderNumber status paymentStatus subtotal deliveryFee discount finalAmount buyerNotes termsMessage cancellationReason
  createdAt updatedAt termsConfirmedAt termsBuyerAcceptedAt
  customer { id name email phone }
  address { recipientName phone line1 line2 city state postalCode }
  items { id sku name priceMode requestedQuantity quantity requestedUnitPrice agreedUnitPrice agreedVariant }
  shipments { courier trackingNumber notes dispatchedAt deliveredAt }
`;

export async function authRequest<T>(
  action: string,
  input: Record<string, unknown> = {},
): Promise<T> {
  const response = await fetch(`/api/auth/${action}`, {
    method: "POST",
    credentials: "same-origin",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(input),
    cache: "no-store",
  });
  const data = (await response.json()) as {
    user?: SessionUser;
    message?: string;
    success?: boolean;
    error?: string;
    code?: string;
  };
  if (!response.ok) {
    const error = new Error(data.error ?? "We couldn’t complete that request.") as GqlError;
    error.code = data.code;
    throw error;
  }
  return data as T;
}
