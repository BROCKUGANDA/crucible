import { describe, expect, it } from "vitest";
import {
  ApprovalQueue,
  AuditLog,
  MemoryStore,
  RollbackRegistry,
  SessionScope,
} from "../src/index.js";
import { sealMemory } from "../src/memory-seal.js";
import type { ApprovalRequest, RiskAssessment } from "../src/types.js";

/**
 * Growth bounds.
 *
 * Every store here is keyed by something an agent or a caller controls — a memory key, a
 * session id, an approval id, a saga scope — so each one is a slow leak with a writable
 * tap on it. These tests do not assert "the value is right"; they assert the population
 * stops growing, because that is the property that fails in production and passes in a
 * demo. Each one is paired with a comment naming the mutation that would make it pass
 * wrongly.
 */

const risk = (score: number): RiskAssessment => ({
  score,
  level: score < 20 ? "low" : score < 50 ? "medium" : "high",
  factors: [],
});

const approval = (id: string, score = 80): Omit<ApprovalRequest, "status" | "requestedAt"> => ({
  id,
  principalId: "p1",
  action: "submitRun",
  resource: `trial/${id}`,
  risk: risk(score),
  requestedAt: 0,
  expiresAt: Number.MAX_SAFE_INTEGER,
});

describe("MemoryStore bounds", () => {
  it("holds the line at maxRecords over a long write stream", () => {
    const mem = new MemoryStore({ maxRecords: 50 });
    for (let i = 0; i < 5_000; i++) {
      const res = mem.write({ key: `k${i}`, value: `v${i}`, provenance: "inference" });
      expect(res.ok).toBe(true);
    }
    expect(mem.size).toBe(50);
    expect(mem.evictedCount).toBe(4_950);
    // If eviction were implemented as "clear the map", size would also stay bounded and
    // this test would still pass. The count is what distinguishes the two.
    expect(mem.all().length).toBe(50);
    expect(mem.all().map((r) => r.key)).toContain("k4999");
    expect(mem.all().map((r) => r.key)).not.toContain("k0");
  });

  it("seals identically for two stores that saw the same writes and evicted the same records", () => {
    // One clock shared by both stores: a seal is a hash over timestamps, so replaying the
    // same writes on two machines is only reproducible if the store's clock is injectable.
    let tick = 0;
    const writes = (store: MemoryStore, n: number) => {
      for (let i = 0; i < n; i++) {
        store.write({ key: `k${i}`, value: { n: i }, provenance: "inference" });
        tick += 1;
      }
    };
    const clock = () => tick;
    const a = new MemoryStore({ maxRecords: 20, now: clock });
    const b = new MemoryStore({ maxRecords: 20, now: clock });
    writes(a, 500);
    tick = 0;
    writes(b, 500);

    expect(a.seal()).toBe(b.seal());
    // …and that seal is NOT reachable by forgetting the evicted prefix: sealing only the
    // survivors would make eviction invisible, which is the thing being tested against.
    expect(a.seal()).not.toBe(sealMemory(a.all()));
  });

  it("detects a tampered retained record through the eviction head", () => {
    const mem = new MemoryStore({ maxRecords: 10 });
    for (let i = 0; i < 40; i++) {
      mem.write({ key: `k${i}`, value: `v${i}`, provenance: "inference" });
    }
    const seal = mem.seal();
    expect(mem.verifySeal(seal)).toBe(true);

    const survivor = mem.all()[0]!;
    survivor.value = "edited out of band";
    expect(mem.verifySeal(seal)).toBe(false);
  });

  it("refuses rather than evicting when every record is a pinned chain fact", () => {
    const mem = new MemoryStore({ maxRecords: 3 });
    for (let i = 0; i < 3; i++) {
      expect(mem.write({ key: `chain${i}`, value: i, provenance: "chain" }).ok).toBe(true);
    }
    const res = mem.write({ key: "one-more", value: 1, provenance: "inference" });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toMatch(/pinned chain facts/);
    // Losing an on-chain fact to make room for an inference would be the worst possible
    // way to stay under a memory cap.
    expect(mem.size).toBe(3);
    expect(mem.read("chain0")).toBeDefined();
  });

  it("keeps the key index honest when a key is rewritten", () => {
    const mem = new MemoryStore({ maxRecords: 100 });
    const first = mem.write({ key: "x", value: 1, provenance: "user" });
    const second = mem.write({ key: "x", value: 2, provenance: "user" });
    expect(first.ok && second.ok).toBe(true);
    if (!second.ok) throw new Error("rewrite should succeed");

    expect(mem.read("x")?.value).toBe(2);
    // A stale index entry would leave the superseded record in `all()` and therefore in
    // the seal, so "one key, one current value" would be a lie the moment anything read
    // the whole store.
    expect(mem.all().filter((r) => r.key === "x").length).toBe(1);
    expect(mem.size).toBe(1);
  });
});

describe("SessionScope bounds", () => {
  let now = 1_000;
  const clock = () => now;

  it("closes idle sessions and keeps live ones", () => {
    const scope = new SessionScope({ idleTtlMs: 500, maxOpen: 100, now: clock });
    scope.create("idle");
    now += 100;
    scope.create("live");
    now += 500;
    // "idle" is 600ms old (> TTL), "live" is 500ms old (not > TTL).
    expect(scope.sweepExpired()).toBe(1);
    expect(scope.isOpen("idle")).toBe(false);
    expect(scope.isOpen("live")).toBe(true);
    expect(scope.sweptCount).toBe(1);
  });

  it("treats activity as liveness", () => {
    const scope = new SessionScope({ idleTtlMs: 500, maxOpen: 100, now: clock });
    scope.create("busy");
    now += 400;
    scope.attach("busy", "k", 1);
    now += 400;
    expect(scope.sweepExpired()).toBe(0);
    expect(scope.isOpen("busy")).toBe(true);
  });

  it("refuses past the cap instead of evicting a live tenant's session", () => {
    const scope = new SessionScope({ idleTtlMs: 10_000, maxOpen: 2, now: clock });
    scope.create("a");
    scope.create("b");
    expect(() => scope.create("c")).toThrow(/session cap reached/);
    // Evicting "a" would also bound the map — and would let "a"'s agent keep writing into
    // a session that no longer exists.
    expect(scope.openCount).toBe(2);
    expect(scope.contents("a")).toEqual([]);
  });

  it("reclaims a slot once an idle session is swept", () => {
    const scope = new SessionScope({ idleTtlMs: 10, maxOpen: 2, now: clock });
    scope.create("a");
    now += 1_000;
    scope.create("b");
    // "a" is expired, so create() sweeps it and takes the freed slot rather than throwing.
    scope.create("c");
    expect(scope.openCount).toBe(2);
    expect(scope.isOpen("a")).toBe(false);
  });
});

describe("ApprovalQueue bounds", () => {
  let now = 10_000;
  const reviewer = async () => ({ approved: true });

  it("prunes decided requests past their TTL and never a pending one", async () => {
    const queue = new ApprovalQueue(reviewer, 20, {
      maxRetained: 100,
      decidedTtlMs: 1_000,
      now: () => now,
    });
    await queue.request(approval("done"));
    expect(queue.size).toBe(1);

    now += 5_000;
    await queue.request(approval("fresh", 5)); // auto-approved, decided
    expect(queue.size).toBe(1);
    expect(queue.dropped).toBe(1);
    expect(queue.get("done")).toBeUndefined();
  });

  it("ages out an auto-approved request on the same clock as a reviewed one", async () => {
    // The two decision paths stamp `decidedAt` separately. If either of them reaches for
    // the wall clock instead of the injected one, that class of request becomes immune to
    // the TTL and the queue leaks exactly the entries nobody ever looks at again.
    const queue = new ApprovalQueue(reviewer, 20, {
      maxRetained: 100,
      decidedTtlMs: 1_000,
      now: () => now,
    });
    await queue.request(approval("cheap", 5)); // auto-approved path
    expect(queue.get("cheap")?.status).toBe("auto-approved");

    now += 5_000;
    await queue.request(approval("dear")); // reviewed path, forces a prune
    expect(queue.get("cheap")).toBeUndefined();
    expect(queue.get("dear")).toBeDefined();
  });

  it("will not evict a request a human has not answered, even past the TTL", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const gated = async () => {
      await gate;
      return { approved: true };
    };
    const queue = new ApprovalQueue(gated, 20, {
      maxRetained: 2,
      decidedTtlMs: 1_000,
      now: () => now,
    });

    const inFlight = queue.request(approval("waiting"));
    await new Promise((r) => setTimeout(r, 0));
    expect(queue.get("waiting")?.status).toBe("pending");

    now += 60_000; // far past the TTL, and past the ceiling for everything else
    expect(queue.prune()).toBe(0);
    expect(queue.get("waiting")).toBeDefined();

    release();
    await inFlight;
    expect(queue.get("waiting")?.status).toBe("approved");
  });

  it("holds the ceiling across a long stream of decisions", async () => {
    const queue = new ApprovalQueue(reviewer, 20, {
      maxRetained: 10,
      decidedTtlMs: 60_000,
      now: () => now,
    });
    for (let i = 0; i < 1_000; i++) await queue.request(approval(`r${i}`));
    expect(queue.size).toBeLessThanOrEqual(10);
    expect(queue.dropped).toBeGreaterThan(900);
  });

  it("fails closed when the queue is full of unanswered requests", async () => {
    const never = () => new Promise<{ approved: boolean }>(() => undefined);
    const queue = new ApprovalQueue(never as any, 20, {
      maxRetained: 2,
      decidedTtlMs: 60_000,
      now: () => now,
    });
    void queue.request(approval("p1"));
    void queue.request(approval("p2"));
    await new Promise((r) => setTimeout(r, 0));
    expect(queue.size).toBe(2);

    // Refusing is the safe direction. Evicting a pending request would let a decision
    // land against a queue that no longer holds the question.
    await expect(queue.request(approval("p3"))).rejects.toThrow(/approval queue is full/);
  });
});

describe("AuditLog retention", () => {
  const record = (log: AuditLog, n: number, at = 1_000) => {
    for (let i = 0; i < n; i++) {
      log.append({
        principalId: "p1",
        action: `tool${i}`,
        resource: "r",
        decision: { allow: true, reason: "ok" } as any,
        at,
      });
    }
  };

  it("holds the ceiling and still reports itself intact", () => {
    const log = new AuditLog(undefined, undefined, { maxEntries: 100, ttlMs: Infinity });
    record(log, 5_000);
    expect(log.retainedCount).toBe(100);
    expect(log.prunedCount).toBe(4_900);
    // This is the property that makes pruning safe at all. Without the anchor, verify()
    // would report the chain broken purely because old entries left.
    expect(log.verify().intact).toBe(true);
  });

  it("a pruned chain still catches tampering of what it kept", () => {
    const log = new AuditLog(undefined, undefined, { maxEntries: 50, ttlMs: Infinity });
    record(log, 500);
    const held = log.all();
    held[10].action = "rewritten";
    expect(log.verify().intact).toBe(false);
    expect(log.verify().brokenAtSeq).toBe(held[10].seq);
  });

  it("proves a prefix that was dropped back against the anchor", () => {
    const full = new AuditLog(undefined, undefined, { maxEntries: 100_000, ttlMs: Infinity });
    record(full, 200);
    const prefix = full.all().slice(0, 120);

    const trimmed = new AuditLog(undefined, undefined, { maxEntries: 80, ttlMs: Infinity });
    record(trimmed, 200);
    expect(trimmed.verifyPrefix(prefix)).toBe(true);

    // One edited byte in the old material and the proof fails — which is the entire
    // reason the anchor exists instead of the prefix simply being trusted.
    const forged = prefix.map((e, i) => (i === 60 ? { ...e, action: "lied" } : e));
    expect(trimmed.verifyPrefix(forged)).toBe(false);
  });

  it("expires entries on a clock it is given", () => {
    let now = 10_000;
    const log = new AuditLog(
      undefined,
      "0".repeat(64),
      { maxEntries: 1_000, ttlMs: 5_000, now: () => now },
    );
    record(log, 3, 10_000);
    expect(log.retainedCount).toBe(3);
    now = 20_000;
    record(log, 1, 20_000);
    expect(log.retainedCount).toBe(1);
    expect(log.prunedCount).toBe(3);
    expect(log.verify().intact).toBe(true);
  });
});

describe("RollbackRegistry bounds", () => {
  it("unwinds the oldest open scope rather than dropping it when the cap is hit", async () => {
    const rollbacks: string[] = [];
    const reg = new RollbackRegistry({ maxScopes: 2, maxDepth: 8 });
    for (let i = 0; i < 6; i++) {
      const id = `s${i}`;
      reg.push(id, {
        description: `undo ${id}`,
        execute: async () => {
          rollbacks.push(id);
        },
      });
      // A later push in the same scope must not evict that same scope.
      if (i === 0) reg.push(id, { description: `undo2 ${id}`, execute: async () => {} });
    }
    expect(reg.openScopes).toBeLessThanOrEqual(2);
    await reg.settle();
    // The whole point: compensations ran, they were not silently discarded.
    expect(rollbacks.length).toBeGreaterThan(0);
    expect(reg.forcedUnwindCount).toBeGreaterThan(0);
  });

  it("refuses a scope that registers compensations forever", () => {
    const reg = new RollbackRegistry({ maxScopes: 10, maxDepth: 3 });
    reg.push("runaway", { description: "a", execute: async () => {} });
    reg.push("runaway", { description: "b", execute: async () => {} });
    reg.push("runaway", { description: "c", execute: async () => {} });
    expect(() =>
      reg.push("runaway", { description: "d", execute: async () => {} }),
    ).toThrow(/refusing more/);
  });

  it("does not mutate the stored stack while unwinding", async () => {
    const seen: string[] = [];
    const reg = new RollbackRegistry({ maxScopes: 4, maxDepth: 4 });
    reg.push("s", { description: "a", execute: async () => { seen.push("a"); } });
    reg.push("s", { description: "b", execute: async () => { seen.push("b"); } });
    expect(reg.depth("s")).toBe(2);
    await reg.rollback("s");
    expect(seen).toEqual(["b", "a"]);
    expect(reg.depth("s")).toBe(0);
  });
});
