import { GraphQLError } from "graphql";
import { OrderStatus } from "@prisma/client";

export const ORDER_TRANSITIONS: Record<OrderStatus, readonly OrderStatus[]> = {
  REQUESTED: ["REVIEWING", "CANCELLED"],
  REVIEWING: ["AWAITING_BUYER_CONFIRMATION", "CANCELLED"],
  AWAITING_BUYER_CONFIRMATION: ["AWAITING_PAYMENT", "CANCELLED"],
  AWAITING_PAYMENT: ["PAYMENT_VERIFIED", "CANCELLED"],
  PAYMENT_VERIFIED: ["READY_TO_DISPATCH", "CANCELLED"],
  READY_TO_DISPATCH: ["DISPATCHED", "CANCELLED"],
  DISPATCHED: ["DELIVERED"],
  DELIVERED: [],
  CANCELLED: [],
};

export function assertTransition(from: OrderStatus, to: OrderStatus) {
  if (!ORDER_TRANSITIONS[from].includes(to)) {
    throw new GraphQLError(`Cannot move an order from ${from} to ${to}.`, {
      extensions: { code: "INVALID_STATE_TRANSITION" },
    });
  }
}

export function assertValidPage(page: number | undefined, pageSize: number | undefined) {
  const currentPage = page ?? 1;
  const size = pageSize ?? 25;
  if (!Number.isInteger(currentPage) || currentPage < 1) {
    throw validationError("Page must be a positive whole number.");
  }
  if (!Number.isInteger(size) || size < 1 || size > 100) {
    throw validationError("Page size must be between 1 and 100.");
  }
  return { page: currentPage, pageSize: size };
}

export function validationError(message: string): GraphQLError {
  return new GraphQLError(message, {
    extensions: { code: "VALIDATION_ERROR" },
  });
}

export function requireText(value: string, label: string, maxLength = 200) {
  const normalized = value.trim();
  if (!normalized || normalized.length > maxLength) {
    throw validationError(`${label} is required and must be at most ${maxLength} characters.`);
  }
  return normalized;
}

export function parsePositiveMoney(value: number, label: string, allowZero = true) {
  if (
    !Number.isSafeInteger(value) ||
    value < (allowZero ? 0 : 1) ||
    value > 100_000_000
  ) {
    throw validationError(`${label} must be a valid amount in whole rupees.`);
  }
  return value;
}

export function assertQuantity(quantity: number) {
  if (!Number.isInteger(quantity) || quantity < 1 || quantity > 50) {
    throw validationError("Each requested quantity must be between 1 and 50.");
  }
}

export function assertPassword(password: string) {
  if (
    password.length < 12 ||
    password.length > 128 ||
    !/[a-z]/.test(password) ||
    !/[A-Z]/.test(password) ||
    !/[0-9]/.test(password)
  ) {
    throw validationError(
      "Use a password with at least 12 characters, including uppercase, lowercase and a number.",
    );
  }
}
