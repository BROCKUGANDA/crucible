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
});
