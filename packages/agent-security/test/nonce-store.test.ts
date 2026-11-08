import { describe, it, expect, beforeEach } from "vitest";
import {
  createMemoryNonceStore,
  createNonceStore,
  type NonceStore,
  type StoredChallenge,
} from "../src/nonce-store";

describe("NonceStore", () => {
  let store: NonceStore;

  const sampleRecord: StoredChallenge = {
    nonce: "abc123",
    message: "Sign in to Crucible",
    address: "0x1234567890abcdef1234567890abcdef12345678",
    issuedAt: Date.now(),
    expiresAt: Date.now() + 60_000,
  };

  describe("in-memory backend", () => {
    beforeEach(() => {
      // Reset the globalThis store for each test
      const STATE_KEY = "__crucible_auth_nonce_store__";
      const globalScope = globalThis as unknown as Record<string, unknown>;
      delete globalScope[STATE_KEY];
      store = createMemoryNonceStore();
    });

    it("stores and retrieves a challenge", async () => {
      await store.set("test-id", sampleRecord, 60_000);
      const result = await store.get("test-id");
      expect(result).toEqual(sampleRecord);
    });

    it("returns null for missing key", async () => {
      const result = await store.get("nonexistent");
      expect(result).toBeNull();
    });

    it("returns null for expired key", async () => {
      // Create a record that is already expired
      const expiredRecord: StoredChallenge = {
        ...sampleRecord,
        issuedAt: Date.now() - 120_000,
        expiresAt: Date.now() - 60_000,
      };
      await store.set("expired-id", expiredRecord, 1); // 1ms TTL
      // Wait for expiration
      await new Promise((r) => setTimeout(r, 10));
      const result = await store.get("expired-id");
      expect(result).toBeNull();
    });

    it("deletes a challenge", async () => {
      await store.set("del-id", sampleRecord, 60_000);
      await store.del("del-id");
      const result = await store.get("del-id");
      expect(result).toBeNull();
    });

    it("updates a challenge with new fields", async () => {
      await store.set("update-id", sampleRecord, 60_000);
      const updated: StoredChallenge = {
        ...sampleRecord,
        signature: "0xsignature",
        sessionToken: "token123",
      };
      await store.set("update-id", updated, 60_000);
      const result = await store.get("update-id");
      expect(result?.signature).toBe("0xsignature");
      expect(result?.sessionToken).toBe("token123");
    });

    it("prune removes expired entries", async () => {
      // Insert an expired entry
      const expiredRecord: StoredChallenge = {
        ...sampleRecord,
        issuedAt: Date.now() - 120_000,
        expiresAt: Date.now() - 60_000,
      };
      await store.set("expired-prune", expiredRecord, 1);
      await new Promise((r) => setTimeout(r, 10));
      await store.prune();
      const result = await store.get("expired-prune");
      expect(result).toBeNull();
    });

    it("prune enforces max entries", async () => {
      // Insert 5 entries
      for (let i = 0; i < 5; i++) {
        await store.set(`prune-max-${i}`, sampleRecord, 60_000);
      }
      await store.prune(3);
      // At least 2 should be gone
      let found = 0;
      for (let i = 0; i < 5; i++) {
        const result = await store.get(`prune-max-${i}`);
        if (result) found++;
      }
      expect(found).toBeLessThanOrEqual(3);
    });

    it("close is a no-op for in-memory", async () => {
      await expect(store.close()).resolves.toBeUndefined();
    });

    it("persists across hot-reload via globalThis", async () => {
      // Creating a second store should reuse the same globalThis map
      // First, write a value with the current store
      await store.set("hot-reload-key", sampleRecord, 60_000);
      // Then create a new store instance — it should share the same map
      const store2 = createMemoryNonceStore();
      const result = await store2.get("hot-reload-key");
      expect(result).toEqual(sampleRecord);
    });
  });

  describe("createNonceStore factory", () => {
    it("creates in-memory store in non-production", async () => {
      const originalEnv = process.env.NODE_ENV;
      process.env.NODE_ENV = "development";
      try {
        const store = await createNonceStore();
        // Should be the in-memory store
        await store.set("factory-test", sampleRecord, 60_000);
        const result = await store.get("factory-test");
        expect(result).toEqual(sampleRecord);
        await store.close();
      } finally {
        process.env.NODE_ENV = originalEnv;
      }
    });
  });
});

/**
 * Atomic consumption — the operation the SIWE replay guard actually rests on.
 *
 * `get` → check → `set` is not consumption: the auth route awaits signature recovery between the
 * read and the write, so two concurrent requests both see an unconsumed challenge. These cases pin
 * the contract that exactly one caller wins, on the backend that can be tested without a daemon.
 * The Redis path runs the same decision inside one Lua script for the same reason.
 */
describe("NonceStore.consume", () => {
  let store: NonceStore;
  const record: StoredChallenge = {
    nonce: "nonce-1",
    message: "Sign in to Crucible",
    address: "0x1234567890abcdef1234567890abcdef12345678",
    issuedAt: Date.now(),
    expiresAt: Date.now() + 60_000,
  };

  beforeEach(() => {
    const globalScope = globalThis as unknown as Record<string, unknown>;
    delete globalScope["__crucible_auth_nonce_store__"];
    store = createMemoryNonceStore();
  });

  it("lets exactly one of two concurrent consumers win", async () => {
    await store.set("c1", { ...record }, 60_000);
    const [a, b] = await Promise.all([
      store.consume("c1", "nonce-1", "sig-a", 60_000),
      store.consume("c1", "nonce-1", "sig-b", 60_000),
    ]);
    expect([a, b].filter(Boolean)).toHaveLength(1);
    // And the winner's signature is the one stored, not the loser's.
    const held = await store.get("c1");
    expect(held?.signature).toBe(a ? "sig-a" : "sig-b");
  });

  it("refuses a second consumption of an already-used challenge", async () => {
    await store.set("c1", { ...record }, 60_000);
    expect(await store.consume("c1", "nonce-1", "sig-a", 60_000)).toBe(true);
    expect(await store.consume("c1", "nonce-1", "sig-a", 60_000)).toBe(false);
  });

  it("refuses when the nonce does not match the stored challenge", async () => {
    await store.set("c1", { ...record }, 60_000);
    expect(await store.consume("c1", "wrong-nonce", "sig", 60_000)).toBe(false);
    // Nothing was written: a failed consume must not mark the challenge used.
    expect((await store.get("c1"))?.signature).toBeUndefined();
  });

  it("refuses a missing or expired challenge", async () => {
    expect(await store.consume("absent", "nonce-1", "sig", 60_000)).toBe(false);
    await store.set("c1", { ...record }, -1);
    expect(await store.consume("c1", "nonce-1", "sig", 60_000)).toBe(false);
  });

  it("extends the window to the consumed TTL, not the challenge TTL", async () => {
    await store.set("c1", { ...record }, 1_000);
    expect(await store.consume("c1", "nonce-1", "sig", 300_000)).toBe(true);
    const held = await store.get("c1");
    expect(held?.expiresAt).toBeGreaterThan(Date.now() + 200_000);
  });
});
