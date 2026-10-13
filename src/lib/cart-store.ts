"use client";

import { useSyncExternalStore } from "react";
import { CART_KEY, CartLine } from "@/lib/store";

const EMPTY_CART: CartLine[] = [];
const listeners = new Set<() => void>();
let snapshot: CartLine[] | undefined;

function normalizeCart(value: unknown): CartLine[] {
  if (!Array.isArray(value)) return [];
  const lines = new Map<string, number>();
  for (const entry of value) {
    if (
      !entry ||
      typeof entry !== "object" ||
      !("productId" in entry) ||
      !("quantity" in entry) ||
      typeof entry.productId !== "string" ||
      !entry.productId ||
      entry.productId.length > 100 ||
      !Number.isInteger(entry.quantity) ||
      entry.quantity < 1 ||
      entry.quantity > 50
    ) {
      console.warn("Ignoring an invalid saved request-bag item.");
      continue;
    }
    if (lines.has(entry.productId)) {
      console.warn("Ignoring a duplicate saved request-bag item.");
      continue;
    }
    lines.set(entry.productId, entry.quantity);
  }
  return [...lines].map(([productId, quantity]) => ({ productId, quantity }));
}

function getSnapshot() {
  if (typeof window === "undefined") return EMPTY_CART;
  if (snapshot === undefined) {
    try {
      const saved: unknown = JSON.parse(
        window.localStorage.getItem(CART_KEY) ?? "[]",
      );
      snapshot = normalizeCart(saved);
    } catch (error) {
      console.error("Could not read the saved request bag.", error);
      snapshot = EMPTY_CART;
    }
  }
  return snapshot;
}

function notify() {
  listeners.forEach((listener) => listener());
}

function handleStorage(event: StorageEvent) {
  if (event.key !== CART_KEY) return;
  snapshot = undefined;
  notify();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  window.addEventListener("storage", handleStorage);
  return () => {
    listeners.delete(listener);
    window.removeEventListener("storage", handleStorage);
  };
}

export function updateCart(
  update: (current: CartLine[]) => CartLine[],
) {
  const next = normalizeCart(update(getSnapshot()));
  snapshot = next;
  window.localStorage.setItem(CART_KEY, JSON.stringify(next));
  notify();
}

export function useCart() {
  return useSyncExternalStore(subscribe, getSnapshot, () => EMPTY_CART);
}
