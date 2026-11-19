import { describe, expect, it } from "vitest";
import { createOutboxRelay } from "../src/outbox.js";

interface Row {
  id: number;
  event_id: string;
  phase: string;
  status: string;
  attempts: number;
  next_attempt_at?: number | null;
  last_error?: string | null;
  created_at?: number;
}

function fakeDb(rows: Row[]) {
  const calls: { text: string; params?: unknown[] }[] = [];
  const exec = async (text: string, params?: unknown[]) => {
    calls.push({ text, params });
    if (text.includes("RETURNING id")) {
      const at = params?.[1] as number;
      const limit = params?.[2] as number;
      const due = rows
        .filter(
          (r) =>
            (r.status === "pending" || r.status === "dispatching") &&
            (r.next_attempt_at == null || r.next_attempt_at <= at),
        )
        .slice(0, limit);
      for (const r of due) {
        r.status = "dispatching";
        r.attempts += 1;
      }
      return {
        rows: due.map((r) => ({ id: r.id, event_id: r.event_id, phase: r.phase, attempts: r.attempts })),
      };
    }
    if (text.includes("DELETE FROM forge_watch_outbox")) {
      const before = params?.[0] as number;
      const removable = rows.filter((r) => r.status === "dispatched" && (r.created_at ?? 0) < before);
      for (const r of removable) {
        rows.splice(rows.indexOf(r), 1);
      }
      return { rows: [], rowCount: removable.length };
    }
    if (text.includes("status = 'quarantined'")) {
      const row = rows.find((r) => r.id === params?.[0]);
      if (row) {
        row.status = "quarantined";
        row.last_error = params?.[1] as string;
      }
      return { rows: [] };
    }
    if (text.includes("status = 'dispatched'")) {
      const row = rows.find((r) => r.id === params?.[0]);
      if (row) row.status = "dispatched";
      return { rows: [] };
    }
    if (text.includes("status = 'pending'")) {
      const row = rows.find((r) => r.id === params?.[0]);
      if (row) {
        row.status = "pending";
        row.next_attempt_at = params?.[1] as number;
        row.last_error = params?.[2] as string;
      }
      return { rows: [] };
    }
    return { rows: [] };
  };
  return { exec, rows, calls };
}

const row = (id: number, status = "pending"): Row => ({
  id,
  event_id: `evt-${id}`,
  phase: "L0",
  status,
  attempts: 0,
});

describe("outbox relay", () => {
  it("delivers a claimed row and marks it dispatched", async () => {
    const db = fakeDb([row(1)]);
    const delivered: string[] = [];
    const relay = createOutboxRelay({
      pgExecutor: db.exec,
      dispatch: async (r) => {
        delivered.push(r.eventId);
      },
      now: () => 1_000,
    });

    expect(await relay.drainOnce()).toBe(1);
    expect(delivered).toEqual(["evt-1"]);
    expect(db.rows[0]!.status).toBe("dispatched");
    expect(db.rows[0]!.attempts).toBe(1);
  });

  it("requeues a failed dispatch with backoff and a recorded error", async () => {
    const db = fakeDb([row(1)]);
    const relay = createOutboxRelay({
      pgExecutor: db.exec,
      dispatch: async () => {
        throw new Error("queue unavailable");
      },
      now: () => 1_000,
    });

    expect(await relay.drainOnce()).toBe(0);
    expect(db.rows[0]!.status).toBe("pending");
    expect(db.rows[0]!.last_error).toBe("queue unavailable");
    // 1 min after the attempt for attempt 1.
    expect(db.rows[0]!.next_attempt_at).toBe(1_000 + 60_000);
  });

  it("claims a bounded batch in id order and leaves the rest pending", async () => {
    const db = fakeDb([row(1), row(2), row(3)]);
    const relay = createOutboxRelay({
      pgExecutor: db.exec,
      dispatch: async () => {},
      batchSize: 2,
      now: () => 1_000,
    });

    expect(await relay.drainOnce()).toBe(2);
    expect(db.rows.map((r) => r.status)).toEqual(["dispatched", "dispatched", "pending"]);
  });

  it("returns 0 when nothing is due", async () => {
    const db = fakeDb([{ ...row(1), next_attempt_at: 5_000 }]);
    const relay = createOutboxRelay({
      pgExecutor: db.exec,
      dispatch: async () => {},
      now: () => 1_000,
    });
    expect(await relay.drainOnce()).toBe(0);
    expect(db.rows[0]!.status).toBe("pending");
  });

  it("quarantines a delivery that exhausts its attempt ceiling", async () => {
    const db = fakeDb([{ ...row(1), attempts: 2 }]);
    const quarantined: { eventId: string; error: string }[] = [];
    const relay = createOutboxRelay({
      pgExecutor: db.exec,
      dispatch: async () => {
        throw new Error("payload will never be accepted");
      },
      maxAttempts: 3,
      now: () => 1_000,
      onQuarantine: (delivery) => {
        quarantined.push({ eventId: delivery.row.eventId, error: delivery.error });
      },
    });

    // The third attempt is the last one the ceiling allows.
    expect(await relay.drainOnce()).toBe(0);
    expect(db.rows[0]!.status).toBe("quarantined");
    expect(quarantined).toEqual([
      { eventId: "evt-1", error: "payload will never be accepted" },
    ]);
  });

  it("keeps retrying below the attempt ceiling", async () => {
    const db = fakeDb([{ ...row(1), attempts: 1 }]);
    const quarantined: string[] = [];
    const relay = createOutboxRelay({
      pgExecutor: db.exec,
      dispatch: async () => {
        throw new Error("temporary outage");
      },
      maxAttempts: 3,
      now: () => 1_000,
      onQuarantine: (delivery) => {
        quarantined.push(delivery.row.eventId);
      },
    });

    expect(await relay.drainOnce()).toBe(0);
    expect(db.rows[0]!.status).toBe("pending");
    expect(quarantined).toEqual([]);
  });

  it("stops claiming a quarantined row", async () => {
    const db = fakeDb([{ ...row(1), status: "quarantined", attempts: 9 }]);
    const relay = createOutboxRelay({
      pgExecutor: db.exec,
      dispatch: async () => {},
      maxAttempts: 3,
      now: () => 1_000,
    });
    expect(await relay.drainOnce()).toBe(0);
    expect(db.rows[0]!.status).toBe("quarantined");
  });

  it("quarantines the row even when the dead-letter write fails", async () => {
    const db = fakeDb([{ ...row(1), attempts: 2 }]);
    const logged: string[] = [];
    const relay = createOutboxRelay({
      pgExecutor: db.exec,
      dispatch: async () => {
        throw new Error("boom");
      },
      maxAttempts: 3,
      now: () => 1_000,
      onLog: (line) => logged.push(line),
      onQuarantine: () => {
        throw new Error("dead-letter store unavailable");
      },
    });

    await relay.drainOnce();
    // The row must not go back to cycling: a failure to record the failure
    // must not also resurrect the work.
    expect(db.rows[0]!.status).toBe("quarantined");
    // ...and the operator must hear about it, because a silenced dead-letter
    // failure is how an outage becomes invisible.
    expect(logged.some((line) => line.includes("dead-letter write failed"))).toBe(true);
  });

  it("purges only dispatched rows older than the cut-off", async () => {
    const db = fakeDb([
      { ...row(1), status: "dispatched", created_at: 500 },
      { ...row(2), status: "dispatched", created_at: 5_000 },
      { ...row(3), status: "pending", created_at: 500 },
    ]);
    const relay = createOutboxRelay({
      pgExecutor: db.exec,
      dispatch: async () => {},
      now: () => 1_000,
    });

    const purged = await relay.purgeDispatched(1_000);
    expect(purged).toBe(1);
    // The pending row is work, not history: it must survive the sweep.
    expect(db.rows.map((r) => r.id)).toContain(3);
    expect(db.rows.map((r) => r.id)).not.toContain(1);

    // The fake database applies the status filter itself, so the outcome
    // above cannot prove the SENT statement was restricted: dropping the
    // restriction from the SQL left this test green. The statement is the
    // contract with PostgreSQL, so it is asserted directly.
    const del = db.calls.find((c) => c.text.includes("DELETE FROM forge_watch_outbox"))!;
    expect(del.text).toContain("status = 'dispatched'");
    expect(del.params?.[0]).toBe(1_000);
  });
});
