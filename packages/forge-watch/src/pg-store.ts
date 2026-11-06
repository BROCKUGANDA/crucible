/**
 * @file pg-store.ts — PostgreSQL-backed EventStore for Forge Watch (WFW-003).
 *
 * Uses the outbox table created by migrations/0001_forge_watch_events.sql.
 * The database enforces envelope uniqueness (event_id PK) and per-run sequence
 * uniqueness ((run_id, sequence) UNIQUE) so a duplicate delivery, retry, or
 * bypass cannot silently create a second version of the same event.
 *
 * The executor is injected to avoid a hard dependency on `pg` and to work with
 * agent-security's pooled `query`/`withTransaction` helpers.
 */

import type { ForgeWatchEvent } from "./events.js";
import type { EventStore } from "./collector.js";

export interface PgQueryResult<T = unknown> {
  rows: T[];
  rowCount?: number | null;
}

export type PgExecutor = <T = unknown>(
  text: string,
  params?: unknown[],
) => Promise<PgQueryResult<T>>;

export interface ForgeWatchEventRow {
  event_id: string;
  schema_version: number;
  timestamp_ms: string | number;
  run_id: string;
  trial_id: string;
  agent_id: string;
  tenant_id: string;
  parent_run_id: string | null;
  sequence: number;
  event_type: string;
  source: string;
  provider_id: string | null;
  model_id: string | null;
  tool_id: string | null;
  permission: string | null;
  authorization_decision: string | null;
  environment_id: string | null;
  payload_digest: string | null;
  policy_digest: string | null;
  context_digest: string | null;
  correlation_id: string | null;
  envelope: ForgeWatchEvent;
  dispatched_at: string | number | null;
  created_at: string | number;
}

function rowToEvent(row: ForgeWatchEventRow): ForgeWatchEvent {
  // Prefer the stored canonical envelope; it is the source of truth.
  const env = row.envelope;
  if (env && typeof env === "object") return env as ForgeWatchEvent;
  // Fallback: reconstruct from columns (should not happen for well-formed rows).
  return {
    eventId: row.event_id,
    schemaVersion: 1 as const,
    timestamp: Number(row.timestamp_ms),
    runId: row.run_id,
    trialId: row.trial_id,
    agentId: row.agent_id,
    tenantId: row.tenant_id,
    parentRunId: row.parent_run_id ?? undefined,
    sequence: row.sequence,
    eventType: row.event_type as ForgeWatchEvent["eventType"],
    source: row.source,
    providerId: row.provider_id ?? undefined,
    modelId: row.model_id ?? undefined,
    toolId: row.tool_id ?? undefined,
    permission: row.permission ?? undefined,
    authorizationDecision: row.authorization_decision as
      | ForgeWatchEvent["authorizationDecision"]
      | undefined,
    environmentId: row.environment_id ?? undefined,
    payloadDigest: row.payload_digest ?? undefined,
    policyDigest: row.policy_digest ?? undefined,
    contextDigest: row.context_digest ?? undefined,
    correlationId: row.correlation_id ?? undefined,
  };
}

/** True when a PG error is a unique-violation (duplicate event / sequence). */
export function isUniqueViolation(err: unknown): boolean {
  const code = (err as { code?: string } | null)?.code;
  return code === "23505";
}

export class PgEventStore implements EventStore {
  constructor(private readonly exec: PgExecutor) {}

  async append(event: ForgeWatchEvent): Promise<void> {
    try {
      await this.exec(
        `INSERT INTO forge_watch_events (
          event_id, schema_version, timestamp_ms, run_id, trial_id, agent_id, tenant_id,
          parent_run_id, sequence, event_type, source, provider_id, model_id, tool_id,
          permission, authorization_decision, environment_id, payload_digest, policy_digest,
          context_digest, correlation_id, envelope
        ) VALUES (
          $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22::jsonb
        )`,
        [
          event.eventId,
          event.schemaVersion,
          event.timestamp,
          event.runId,
          event.trialId,
          event.agentId,
          event.tenantId,
          event.parentRunId ?? null,
          event.sequence,
          event.eventType,
          event.source,
          event.providerId ?? null,
          event.modelId ?? null,
          event.toolId ?? null,
          event.permission ?? null,
          event.authorizationDecision ?? null,
          event.environmentId ?? null,
          event.payloadDigest ?? null,
          event.policyDigest ?? null,
          event.contextDigest ?? null,
          event.correlationId ?? null,
          JSON.stringify(event),
        ],
      );
    } catch (err) {
      if (isUniqueViolation(err)) {
        throw new Error(`duplicate forge-watch event: ${event.eventId}`);
      }
      throw err;
    }
  }

  async get(runId: string, sequence: number): Promise<ForgeWatchEvent | null> {
    const res = await this.exec<ForgeWatchEventRow>(
      `SELECT * FROM forge_watch_events WHERE run_id = $1 AND sequence = $2`,
      [runId, sequence],
    );
    const row = res.rows[0];
    return row ? rowToEvent(row) : null;
  }

  async list(runId: string): Promise<ForgeWatchEvent[]> {
    const res = await this.exec<ForgeWatchEventRow>(
      `SELECT * FROM forge_watch_events WHERE run_id = $1 ORDER BY sequence ASC`,
      [runId],
    );
    return res.rows.map(rowToEvent);
  }

  /** Mark events dispatched (outbox). */
  async markDispatched(eventIds: string[], atMs = Date.now()): Promise<void> {
    if (eventIds.length === 0) return;
    await this.exec(
      `UPDATE forge_watch_events SET dispatched_at = $2 WHERE event_id = ANY($1::text[])`,
      [eventIds, atMs],
    );
  }

  /** Fetch undispatched events for a run (outbox drain). */
  async listUndispatched(runId: string, limit = 100): Promise<ForgeWatchEvent[]> {
    const res = await this.exec<ForgeWatchEventRow>(
      `SELECT * FROM forge_watch_events
       WHERE run_id = $1 AND dispatched_at IS NULL
       ORDER BY sequence ASC LIMIT $2`,
      [runId, limit],
    );
    return res.rows.map(rowToEvent);
  }
}

/** Create a PgEventStore from an executor (e.g. agent-security's `query`). */
export function createPgEventStore(exec: PgExecutor): PgEventStore {
  return new PgEventStore(exec);
}
