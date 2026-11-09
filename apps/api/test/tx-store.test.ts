import { describe, expect, it } from "vitest";
import { InMemoryTxStore } from "../src/tx-store.js";

describe("tx store (in-memory)", () => {
  it("creates and reads intent", async () => {
    const s = new InMemoryTxStore();
    const intent = await s.createIntent({
      id: "i1", principal: "p", tenantId: "t", chainId: 1, target: "0x", method: "m",
      payload: {}, state: "pending", idempotencyKey: "k1", createdAt: 1, updatedAt: 1,
    });
    expect(intent.id).toBe("i1");
    const got = await s.getIntent("i1");
    expect(got?.state).toBe("pending");
  });

  it("idempotency lookup returns existing", async () => {
    const s = new InMemoryTxStore();
    await s.createIntent({
      id: "i1", principal: "p", tenantId: "t", chainId: 1, target: "0x", method: "m",
      payload: {}, state: "pending", idempotencyKey: "k1", createdAt: 1, updatedAt: 1,
    });
    const found = await s.findByIdempotency("p", "k1");
    expect(found?.id).toBe("i1");
    const missing = await s.findByIdempotency("p", "nope");
    expect(missing).toBeNull();
  });

  it("updates state", async () => {
    const s = new InMemoryTxStore();
    await s.createIntent({
      id: "i1", principal: "p", tenantId: "t", chainId: 1, target: "0x", method: "m",
      payload: {}, state: "pending", idempotencyKey: null, createdAt: 1, updatedAt: 1,
    });
    await s.updateState("i1", "finalized");
    const got = await s.getIntent("i1");
    expect(got?.state).toBe("finalized");
  });

  it("outbox enqueue + claim + result", async () => {
    const s = new InMemoryTxStore();
    await s.enqueueOutbox("i1");
    const claimed = await s.claimNextOutbox(Date.now() + 1000);
    expect(claimed?.intentId).toBe("i1");
    expect(claimed?.attempt).toBe(1);
    await s.markOutboxResult("i1", "boom");
    // second claim with same item already claimed (attempt incremented); still present
    const claimed2 = await s.claimNextOutbox(Date.now() + 1000);
    expect(claimed2?.attempt).toBe(2);
  });

  it("nonce get/set", async () => {
    const s = new InMemoryTxStore();
    expect(await s.getNonce("0xabc", 1)).toBe(0);
    await s.setNonce("0xabc", 1, 5);
    expect(await s.getNonce("0xabc", 1)).toBe(5);
    expect(await s.getNonce("0xabc", 2)).toBe(0);
  });
});
