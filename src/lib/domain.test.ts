import { describe, expect, it } from "vitest";
import {
  assertPassword,
  assertQuantity,
  assertTransition,
  assertValidPage,
  parsePositiveMoney,
  requireText,
} from "./domain";

describe("order transitions", () => {
  it("allows the complete request-to-delivery path", () => {
    const path = [
      ["REQUESTED", "REVIEWING"],
      ["REVIEWING", "AWAITING_BUYER_CONFIRMATION"],
      ["AWAITING_BUYER_CONFIRMATION", "AWAITING_PAYMENT"],
      ["AWAITING_PAYMENT", "PAYMENT_VERIFIED"],
      ["PAYMENT_VERIFIED", "READY_TO_DISPATCH"],
      ["READY_TO_DISPATCH", "DISPATCHED"],
      ["DISPATCHED", "DELIVERED"],
    ] as const;
    for (const [from, to] of path) expect(() => assertTransition(from, to)).not.toThrow();
    expect(() => assertTransition("REQUESTED", "CANCELLED")).not.toThrow();
    expect(() => assertTransition("AWAITING_BUYER_CONFIRMATION", "PAYMENT_VERIFIED")).toThrow(
      "Cannot move an order",
    );
    expect(() => assertTransition("DISPATCHED", "CANCELLED")).toThrow(
      "Cannot move an order",
    );
  });
});

describe("request and money validation", () => {
  it("applies bounded pagination defaults and rejects invalid sizes", () => {
    expect(assertValidPage(undefined, undefined)).toEqual({ page: 1, pageSize: 25 });
    expect(assertValidPage(3, 100)).toEqual({ page: 3, pageSize: 100 });
    expect(() => assertValidPage(0, 25)).toThrow("positive whole number");
    expect(() => assertValidPage(1, 101)).toThrow("between 1 and 100");
  });

  it("accepts only safe, non-negative whole-rupee values", () => {
    expect(parsePositiveMoney(0, "Price")).toBe(0);
    expect(parsePositiveMoney(1200, "Price", false)).toBe(1200);
    expect(() => parsePositiveMoney(-1, "Price")).toThrow("valid amount");
    expect(() => parsePositiveMoney(1.25, "Price")).toThrow("valid amount");
    expect(() => parsePositiveMoney(Number.MAX_SAFE_INTEGER + 1, "Price")).toThrow(
      "valid amount",
    );
  });

  it("bounds item quantity and trims required text", () => {
    expect(() => assertQuantity(1)).not.toThrow();
    expect(() => assertQuantity(50)).not.toThrow();
    expect(() => assertQuantity(0)).toThrow("between 1 and 50");
    expect(() => assertQuantity(51)).toThrow("between 1 and 50");
    expect(requireText("  Bansuri  ", "Product")).toBe("Bansuri");
    expect(() => requireText(" ", "Product")).toThrow("is required");
  });

  it("requires a strong bounded account password", () => {
    expect(() => assertPassword("CorrectHorse42")).not.toThrow();
    expect(() => assertPassword("short1A")).toThrow("at least 12 characters");
    expect(() => assertPassword("lowercasepassword1")).toThrow("at least 12 characters");
    expect(() => assertPassword("UppercasePassword")).toThrow("at least 12 characters");
  });
});
