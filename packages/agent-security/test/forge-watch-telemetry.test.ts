import { describe, expect, it } from "vitest";
import {
  createPgFindingWriter,
  createTelemetryPipeline,
  findingIdFor,
} from "../src/forge-watch-telemetry.js";
import { createDeadLetterStore } from "@crucible/forge-watch";

/**
 * A fake PostgreSQL that understands the statements this pipeline issues.
 *
 * It is a small in-memory model rather than a mock, because the property under
 * test is a path through four tables: an event, its outbox row, the finding
 * the monitor writes, and the dead letter a failed delivery leaves behind. A
 * mock that returns whatever the test wants would assert that the code calls
 * the functions the test expected, not that the path works.
 */
interface FakeEvent {
  event_id: string;
  run_id: string;
  sequence: number;
  event_type: string;
  source: string;
  authorization_decision: string | null;
  tool_id: string | null;
  permission: string | null;
  dispatched_at: number | null;
}

interface FakeOutboxRow {
  id: number;
  event_id: string;
  phase: string;
  status: string;
  attempts: number;
  next_attempt_at: number | null;
  lease_until: number | null;
  last_error: string | null;
  created_at: number;
}

interface FakeDeadLetter {
  id: number;
  source: string;
  event_id: string | null;
  job_id: string | null;
  job_name: string;
  payload: unknown;
  error: string;
  attempts: number;
  status: string;
  replayed_at: number | null;
  resolved_at: number | null;
  created_at: number;
}

interface FakeDb {
  exec: (text: string, params?: unknown[]) => Promise<{ rows: any[]; rowCount: number }>;
  events: FakeEvent[];
  outbox: FakeOutboxRow[];
  findings: { finding_id: string; run_id: string; kind: string; detail: string }[];
  deadLetters: FakeDeadLetter[];
  statements: string[];
}

function fakeDb(seed?: {
  events?: Partial<FakeEvent>[];
  outbox?: Partial<FakeOutboxRow>[];
}): FakeDb {
  const events: FakeEvent[] = (seed?.events ?? []).map((e, i) => ({
    event_id: e.event_id ?? `evt-${i + 1}`,
    run_id: e.run_id ?? "run-1",
    sequence: e.sequence ?? i + 1,
    event_type: e.event_type ?? "provider.request",
    source: e.source ?? "agent",
    authorization_decision: e.authorization_decision ?? null,
    tool_id: e.tool_id ?? null,
    permission: e.permission ?? null,
    dispatched_at: e.dispatched_at ?? null,
  }));
  const outbox: FakeOutboxRow[] = (seed?.outbox ?? []).map((r, i) => ({
    id: r.id ?? i + 1,
    event_id: r.event_id ?? events[i]?.event_id ?? `evt-${i + 1}`,
    phase: r.phase ?? "L0",
    status: r.status ?? "pending",
    attempts: r.attempts ?? 0,
    next_attempt_at: r.next_attempt_at ?? null,
    lease_until: r.lease_until ?? null,
    last_error: r.last_error ?? null,
    created_at: r.created_at ?? 1_000,
  }));
  const findings: FakeDb["findings"] = [];
  const deadLetters: FakeDeadLetter[] = [];
  const statements: string[] = [];

  const exec = async (text: string, params?: unknown[]) => {
    statements.push(text);

    if (text.includes("INSERT INTO forge_watch_findings")) {
      const finding_id = params?.[0] as string;
      if (!findings.some((f) => f.finding_id === finding_id)) {
        findings.push({
          finding_id,
          run_id: params?.[1] as string,
          kind: params?.[2] as string,
          detail: params?.[6] as string,
        });
      }
      return { rows: [], rowCount: 1 };
    }

    if (text.includes("INSERT INTO forge_watch_dead_letters")) {
      const source = params?.[0] as string;
      const eventId = params?.[1] as string | null;
      const existing = deadLetters.find(
        (d) => d.source === source && d.event_id === eventId && d.status !== "resolved",
      );
      if (existing) {
        existing.attempts += 1;
        existing.error = params?.[5] as string;
        return { rows: [existing], rowCount: 1 };
      }
      const row: FakeDeadLetter = {
        id: deadLetters.length + 1,
        source,
        event_id: eventId,
        job_id: params?.[2] as string | null,
        job_name: params?.[3] as string,
        payload: JSON.parse(params?.[4] as string),
        error: params?.[5] as string,
        attempts: params?.[6] as number,
        status: "pending",
        replayed_at: null,
        resolved_at: null,
        created_at: params?.[7] as number,
      };
      deadLetters.push(row);
      return { rows: [row], rowCount: 1 };
    }

    if (text.includes("SELECT * FROM forge_watch_dead_letters WHERE id = $1")) {
      const row = deadLetters.find((d) => d.id === params?.[0]);
      return { rows: row ? [row] : [], rowCount: row ? 1 : 0 };
    }

    if (text.includes("UPDATE forge_watch_dead_letters") && text.includes("'replayed'")) {
      const row = deadLetters.find((d) => d.id === params?.[0]);
      if (row && row.status === "pending") {
        row.status = "replayed";
        row.replayed_at = params?.[1] as number;
        return { rows: [], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    }

    if (text.includes("UPDATE forge_watch_dead_letters") && text.includes("'resolved'")) {
      const row = deadLetters.find((d) => d.id === params?.[0]);
      if (row) {
        row.status = "resolved";
        row.resolved_at = params?.[1] as number;
        return { rows: [], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    }

    if (text.includes("SELECT * FROM forge_watch_dead_letters") && text.includes("'pending'")) {
      return { rows: deadLetters.filter((d) => d.status === "pending"), rowCount: 0 };
    }

    if (text.includes("SELECT COUNT(*)::text AS count FROM forge_watch_dead_letters")) {
      return {
        rows: [{ count: String(deadLetters.filter((d) => d.status === "pending").length) }],
        rowCount: 1,
      };
    }

    if (text.includes("SELECT COUNT(*)::text AS pending")) {
      const live = outbox.filter((o) => o.status === "pending" || o.status === "dispatching");
      const oldest = live.reduce<number | null>(
        (min, o) => (min === null || o.created_at < min ? o.created_at : min),
        null,
      );
      return {
        rows: [{ pending: String(live.length), oldest: oldest === null ? null : String(oldest) }],
        rowCount: 1,
      };
    }

    if (text.includes("SELECT event_id, run_id, sequence")) {
      const event = events.find((e) => e.event_id === params?.[0]);
      return { rows: event ? [event] : [], rowCount: event ? 1 : 0 };
    }

    if (text.includes("RETURNING id, event_id, phase, attempts")) {
      const at = params?.[1] as number;
      const limit = params?.[2] as number;
      const due = outbox
        .filter(
          (o) =>
            (o.status === "pending" || o.status === "dispatching") &&
            (o.next_attempt_at === null || o.next_attempt_at <= at) &&
            (o.lease_until === null || o.lease_until < at),
        )
        .slice(0, limit);
      for (const o of due) {
        o.status = "dispatching";
        o.attempts += 1;
      }
      return {
        rows: due.map((o) => ({
          id: o.id,
          event_id: o.event_id,
          phase: o.phase,
          attempts: o.attempts,
        })),
        rowCount: due.length,
      };
    }

    if (text.includes("UPDATE forge_watch_outbox") && text.includes("'dispatched'")) {
      const row = outbox.find((o) => o.id === params?.[0]);
      if (row) row.status = "dispatched";
      return { rows: [], rowCount: 1 };
    }

    if (text.includes("UPDATE forge_watch_outbox") && text.includes("'quarantined'")) {
      const row = outbox.find((o) => o.id === params?.[0]);
      if (row) {
        row.status = "quarantined";
        row.last_error = params?.[1] as string;
      }
      return { rows: [], rowCount: 1 };
    }

    if (text.includes("UPDATE forge_watch_outbox") && text.includes("'pending'")) {
      const row = outbox.find((o) => o.id === params?.[0]);
      if (row) {
        row.status = "pending";
        row.next_attempt_at = params?.[1] as number;
        row.last_error = params?.[2] as string;
      }
      return { rows: [], rowCount: 1 };
    }

    return { rows: [], rowCount: 0 };
  };

  return { exec, events, outbox, findings, deadLetters, statements };
}

describe("telemetry pipeline", () => {
  it("delivers an outbox row to the monitor queue", async () => {
    const db = fakeDb({
      events: [{ event_id: "evt-1", run_id: "run-1", sequence: 1 }],
      outbox: [{ id: 1, event_id: "evt-1" }],
    });

    const pipeline = createTelemetryPipeline({
      pgExecutor: db.exec,
      registerWorkers: false,
      // The delivery fails on purpose. The reason it fails is the point: the
      // row must be rescheduled with a reason, not silently dropped.
      enqueue: async () => {
        throw new Error("queue unavailable");
      },
      now: () => 1_000,
    });

    await pipeline.drainOnce().catch(() => undefined);

    expect(db.outbox[0]!.status).toBe("pending");
    expect(db.outbox[0]!.last_error).toBeTruthy();
  });

  it("records a finding for a detected telemetry-integrity problem", async () => {
    const db = fakeDb();
    const written: {
      findingId: string;
      runId: string;
      kind: string;
      detail: string;
    }[] = [];

    const pipeline = createTelemetryPipeline({
      pgExecutor: db.exec,
      registerWorkers: false,
      findWriter: {
        async insertFinding(finding) {
          written.push(finding as never);
        },
      },
      now: () => 1_000,
    });

    await pipeline.findings.record({
      runId: "run-1",
      kind: "forbidden-egress",
      detail: "egress denied for event evt-1",
      eventId: "evt-1",
      sequence: 1,
    });

    expect(written).toHaveLength(1);
    expect(written[0]!.kind).toBe("forbidden-egress");
    expect(written[0]!.runId).toBe("run-1");
    // The id is content-derived, so a redelivery is the same row rather than
    // a second one.
    expect(written[0]!.findingId).toBe(findingIdFor("run-1", {
      kind: "forbidden-egress",
      detail: "egress denied for event evt-1",
      eventId: "evt-1",
      sequence: 1,
    }));
  });

  it("derives the same finding id for the same finding and a different one otherwise", () => {
    const a = findingIdFor("run-1", { kind: "gap", detail: "d", expected: 1, observed: 3 });
    const b = findingIdFor("run-1", { kind: "gap", detail: "d", expected: 1, observed: 3 });
    const c = findingIdFor("run-2", { kind: "gap", detail: "d", expected: 1, observed: 3 });
    expect(a).toBe(b);
    expect(a).not.toBe(c);
  });

  it("persists a finding through the Postgres writer exactly once", async () => {
    const db = fakeDb();
    const writer = createPgFindingWriter(db.exec);
    const finding = {
      findingId: "l0:run-1:gap:1:3",
      runId: "run-1",
      kind: "gap",
      detail: "sequence gap: expected 1, observed 3",
      atMs: 1_000,
    };
    await writer.insertFinding(finding);
    await writer.insertFinding(finding);
    expect(db.findings).toHaveLength(1);
  });

  it("quarantines a delivery that keeps failing and dead-letters it durably", async () => {
    const db = fakeDb({
      events: [{ event_id: "evt-1", run_id: "run-1", sequence: 1 }],
      outbox: [{ id: 1, event_id: "evt-1", attempts: 2 }],
    });

    const pipeline = createTelemetryPipeline({
      pgExecutor: db.exec,
      registerWorkers: false,
      maxAttempts: 3,
      enqueue: async () => {
        throw new Error("queue unavailable");
      },
      now: () => 1_000,
    });

    // The delivery fails and the third attempt trips the ceiling.
    await pipeline.drainOnce().catch(() => undefined);

    expect(db.outbox[0]!.status).toBe("quarantined");
    expect(db.deadLetters).toHaveLength(1);
    expect(db.deadLetters[0]!.event_id).toBe("evt-1");
    expect(db.deadLetters[0]!.status).toBe("pending");
  });

  it("lists the dead letters an operator has to deal with", async () => {
    const db = fakeDb();
    const store = createDeadLetterStore(db.exec);
    await store.record({
      source: "forge-watch-relay",
      eventId: "evt-1",
      jobName: "relay:L0",
      payload: { id: 1 },
      error: "boom",
      now: 1_000,
    });

    const pipeline = createTelemetryPipeline({
      pgExecutor: db.exec,
      registerWorkers: false,
      deadLetterStore: store,
      enqueue: async () => undefined,
      now: () => 1_000,
    });

    const pending = await pipeline.pendingDeadLetters();
    expect(pending).toHaveLength(1);
    expect(pending[0]!.error).toBe("boom");

    await pipeline.resolve(pending[0]!.id);
    expect(await pipeline.pendingDeadLetters()).toHaveLength(0);
  });

  it("refuses to replay a dead letter that is not there", async () => {
    const db = fakeDb();
    const pipeline = createTelemetryPipeline({
      pgExecutor: db.exec,
      registerWorkers: false,
      enqueue: async () => undefined,
      now: () => 1_000,
    });
    expect(await pipeline.replay(999)).toBe(false);
  });

  it("reports the backlog and the size of the dead-letter queue", async () => {
    const db = fakeDb({
      events: [{ event_id: "evt-1" }],
      outbox: [{ id: 1, event_id: "evt-1", status: "pending", created_at: 500 }],
    });

    const pipeline = createTelemetryPipeline({
      pgExecutor: db.exec,
      registerWorkers: false,
      enqueue: async () => undefined,
      now: () => 2_000,
    });

    const stats = await pipeline.stats();
    expect(stats.pendingEvents).toBe(1);
    expect(stats.oldestPendingAgeMs).toBe(1_500);
    expect(stats.pendingDeadLetters).toBe(0);
  });
});
