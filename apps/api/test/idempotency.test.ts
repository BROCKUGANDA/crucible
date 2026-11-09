import { describe, expect, it } from "vitest";
import { IdempotencyStore, parseIdempotencyKey } from "../src/idempotency.js";

describe("IdempotencyStore", () => {
  it("returns the first value for a repeated key inside one scope", () => {
    const store = new IdempotencyStore();
    expect(store.get("wallet-a", "k1")).toBeNull();
    store.set("wallet-a", "k1", "run-1");
    expect(store.get("wallet-a", "k1")).toBe("run-1");
  });

  it("scopes keys by principal so one wallet cannot replay another's", () => {
    const store = new IdempotencyStore();
    store.set("wallet-a", "k1", "run-a");
    expect(store.get("wallet-b", "k1")).toBeNull();
  });

  it("forgets an entry once its TTL passes", async () => {
    const store = new IdempotencyStore(1, 10);
    store.set("s", "k", "v");
    await new Promise<void>((resolve) => setTimeout(resolve, 5));
    expect(store.get("s", "k")).toBeNull();
  });

  it("evicts the oldest entry past the bound", () => {
    const store = new IdempotencyStore(60_000, 2);
    store.set("s", "a", "1");
    store.set("s", "b", "2");
    store.set("s", "c", "3");
    expect(store.get("s", "a")).toBeNull();
    expect(store.get("s", "c")).toBe("3");
  });
});

describe("parseIdempotencyKey", () => {
  it("treats absent and blank as no key", () => {
    expect(parseIdempotencyKey(null)).toEqual({ key: null, error: null });
    expect(parseIdempotencyKey("  ")).toEqual({ key: null, error: null });
  });

  it("bounds the key length and trims what it accepts", () => {
    expect(parseIdempotencyKey("x".repeat(201)).error).toMatch(/200 characters/);
    expect(parseIdempotencyKey(" ok ")).toEqual({ key: "ok", error: null });
  });
});
