import { describe, expect, it } from "vitest";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import {
  PgEventStore,
  ForgeWatchEventType,
  parseForgeWatchEvent,
  forgeWatchEvent,
} from "../src/index.js";

const DATABASE_URL = process.env.DATABASE_URL;
const canRun = typeof DATABASE_URL === "string" && DATABASE_URL.length > 0;

describe.skipIf(!canRun)("PgEventStore integration (DATABASE_URL)", () => {
  it("runs migration SQL idempotently and stores/reads events", async () => {
    const pg = await import("pg");
    const pool = new pg.Pool({ connectionString: DATABASE_URL, max: 2 });
    try {
      const migration = await readFile(
        resolve(process.cwd(), "../../migrations/0001_forge_watch_events.sql"),
        "utf8",
      );
      // Simple split (migration is idempotent DDL/DML).
      for (const stmt of migration.split(/;\s*\n/)) {
        const t = stmt.trim();
        if (t) await pool.query(t);
      }

      const store = new PgEventStore((text, params) => pool.query(text, params));
      const runId = `run_it_${Date.now()}_${Math.random().toString(36).slice(2)}`;
      const event = parseForgeWatchEvent(
        forgeWatchEvent(
          {
            runId,
            trialId: "trial_it",
            agentId: "agent_it",
            tenantId: "tenant_it",
            eventType: ForgeWatchEventType.agentTurnStart,
            source: "integration-test",
          },
          { sequence: 1 },
        ),
      );
      await store.append(event);
      const got = await store.get(runId, 1);
      expect(got?.eventId).toBe(event.eventId);
      const list = await store.list(runId);
      expect(list).toHaveLength(1);

      await store.insertFinding({
        findingId: `finding_it_${runId}`,
        runId,
        kind: "gap",
        sequence: 2,
        expected: 2,
        observed: 3,
        detail: "integration test finding",
        atMs: Date.now(),
      });

      // Cleanup best-effort (doesn't affect idempotency contract).
      await pool.query("DELETE FROM forge_watch_findings WHERE run_id = $1", [runId]);
      await pool.query("DELETE FROM forge_watch_events WHERE run_id = $1", [runId]);
    } finally {
      await pool.end();
    }
  });
});
