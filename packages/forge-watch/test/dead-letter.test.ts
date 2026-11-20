import { describe, expect, it } from "vitest";
import { createDeadLetterStore, serialisePayload } from "../src/dead-letter.js";

/**
 * A fake executor that records the statements it was handed.
 *
 * The store's contract with PostgreSQL is the SQL it runs, so the tests
 * assert on that SQL rather than on a mock's return values: a store that
 * stops issuing `ON CONFLICT` would still pass a mock-based test that only
 * checked "record returns a row".
 */
interface Exec {
  (text: string, params?: unknown[]): Promise<{ rows: any[]; rowCount: number }>;
}

function fakeDb(options?: {
  row?: Record<string, unknown>;
  affected?: number;
}) {
  const calls: { text: string; params?: unknown[] }[] = [];
  const exec: Exec = async (text, params) => {
    calls.push({ text, params });
    if (text.includes("INSERT INTO forge_watch_dead_letters")) {
      return {
        rows: [
          {
            id: 1,
            source: params?.[0],
            event_id: params?.[1] ?? null,
            job_id: params?.[2] ?? null,
            job_name: params?.[3],
            payload: { echoed: params?.[4] },
            error: params?.[5],
            attempts: params?.[6],
            status: "pending",
            replayed_at: null,
            resolved_at: null,
            created_at: params?.[7],
          },
        ],
        rowCount: 1,
      };
    }
    if (text.includes("DELETE") || text.includes("UPDATE")) {
      return { rows: [], rowCount: options?.affected ?? 0 };
    }
    if (text.includes("SELECT * FROM forge_watch_dead_letters WHERE id = $1")) {
      return { rows: options?.row ? [options.row] : [], rowCount: options?.row ? 1 : 0 };
    }
    if (text.includes("WHERE status = 'pending'")) {
      return { rows: [], rowCount: 0 };
    }
    return { rows: [], rowCount: 0 };
  };
  return { exec, calls };
}

describe("dead-letter store", () => {
  it("writes a dead letter with the failed payload and reason", async () => {
    const db = fakeDb();
    const store = createDeadLetterStore(db.exec);

    const record = await store.record({
      source: "forge-watch-l0",
      eventId: "evt-1",
      jobName: "monitor",
      payload: { runId: "r1" },
      error: "queue unavailable",
      attempts: 5,
    });

    expect(record.source).toBe("forge-watch-l0");
    expect(record.eventId).toBe("evt-1");
    expect(record.error).toBe("queue unavailable");
    expect(record.attempts).toBe(5);
    expect(record.status).toBe("pending");

    const insert = db.calls.find((c) => c.text.includes("INSERT INTO forge_watch_dead_letters"))!;
    expect(insert.params?.[4]).toBe(JSON.stringify({ runId: "r1" }));
  });

  it("upserts on the same identity so repeated failures update one row", async () => {
    const db = fakeDb();
    const store = createDeadLetterStore(db.exec);

    await store.record({
      source: "forge-watch-l0",
      eventId: "evt-1",
      jobName: "monitor",
      payload: {},
      error: "first",
    });

    const insert = db.calls.find((c) => c.text.includes("INSERT INTO forge_watch_dead_letters"))!;
    // Without ON CONFLICT the second failure of the same event stacks a
    // second row and "how many times has this failed" stops being answerable.
    expect(insert.text).toContain("ON CONFLICT");
    expect(insert.text).toContain("attempts = forge_watch_dead_letters.attempts + 1");
  });

  it("reports a replay only when a pending row was actually marked", async () => {
    const db = fakeDb({ affected: 1 });
    const store = createDeadLetterStore(db.exec);
    expect(await store.markReplayed(7)).toBe(true);

    const missing = fakeDb({ affected: 0 });
    const store2 = createDeadLetterStore(missing.exec);
    expect(await store2.markReplayed(7)).toBe(false);

    // A replay must not mark a row that is not pending: re-queueing a
    // resolved message would resurrect work an operator already closed.
    expect(missing.calls[0]!.text).toContain("status = 'pending'");
  });

  it("resolves a dead letter by id", async () => {
    const db = fakeDb({ affected: 1 });
    const store = createDeadLetterStore(db.exec);
    expect(await store.markResolved(3)).toBe(true);
    expect(db.calls[0]!.text).toContain("status = 'resolved'");
  });

  it("lists the pending queue oldest first", async () => {
    const db = fakeDb();
    const store = createDeadLetterStore(db.exec);
    await store.listPending(25);
    const select = db.calls.find((c) => c.text.includes("WHERE status = 'pending'"))!;
    expect(select.text).toContain("ORDER BY created_at ASC");
    expect(select.params?.[0]).toBe(25);
  });

  it("never throws on a payload that cannot be serialised", async () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    expect(() => serialisePayload(circular)).not.toThrow();
    const text = serialisePayload(circular);
    expect(JSON.parse(text).unserialisable).toBe(true);

    // A BigInt is the other classic: JSON.stringify throws on it.
    expect(() => serialisePayload({ amount: 1n })).not.toThrow();

    const db = fakeDb();
    const store = createDeadLetterStore(db.exec);
    await expect(
      store.record({
        source: "forge-watch-l0",
        eventId: "evt-2",
        jobName: "monitor",
        payload: circular,
        error: "boom",
      }),
    ).resolves.toBeTruthy();
  });
});
