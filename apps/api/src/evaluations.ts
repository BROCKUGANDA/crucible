import { Hono, type Context } from "hono";
import type { Hex } from "viem";
import { isCid } from "@crucible/cidstore";
import type { ContentLookup } from "./content.js";
import type { EvaluationRecord } from "@crucible/smith";

/**
 * `GET /evaluations` — the verified evidence for one run, by run.
 *
 * Read-only, and it reads from a source the host assembles (`createEvaluationSource` in
 * `evaluations-source.ts`): chain runs, the disclosure's run→manifest pointer, the manifest
 * bytes themselves, and the verification envelopes published beside them. Nothing here
 * computes a verdict; a route that graded work would be a second evaluator beside Argus.
 *
 * **The cursor is `(timestamp, evaluationId)`, and that is a deliberate departure.** The
 * read models elsewhere page by item id under ADR-0010, whose argument — a block cursor is
 * the chain's own ordering and needs no tie-breaker — holds for anything ordered by chain
 * position. Evaluation records are ordered by when they were *verified*, which is not chain
 * position and collides on whole seconds, so a pair is the only stable key: the timestamp
 * orders, the id breaks ties. ADR-0024 records the divergence rather than editing ADR-0010
 * to make it agree, which is the rule this repository follows for every such change.
 *
 * The consequence that has to be said out loud: a row whose `timestamp` is corrected by a
 * later hydration (`hydrateTimestamps` in the indexer) can move between pages. That is why
 * the page boundary is echoed back (`meta.cursor`) and the client is told to re-request from
 * the start when `meta.orderKey` changes, rather than being handed a cursor that silently
 * skips a row.
 */

export interface EvaluationPage {
  records: EvaluationRecord[];
  nextCursor: string | null;
  total: number;
}

export interface EvaluationSource {
  /** Every projected record the host can currently assemble. */
  records(): EvaluationRecord[];
  /** The published verification history for one run, oldest version first. */
  history(runHash: Hex): { cid: string; reportVersion: number; envelope: unknown }[];
  /** Read pinned bytes by CID, for `/evidence`. */
  lookup: ContentLookup;
}

const MAX_PAGE = 200;
const DEFAULT_PAGE = 50;
/** What the ordering is keyed on. A client that sees this change restarts its walk. */
const ORDER_KEY = "verified-at-then-id";

class CursorError extends Error {}

function encodeCursor(record: EvaluationRecord): string {
  return Buffer.from(`${record.identity.timestamp}:${record.evaluationId.toLowerCase()}`, "utf8").toString(
    "base64url",
  );
}

function decodeCursor(raw: string): { timestamp: number; evaluationId: string } {
  const text = Buffer.from(raw, "base64url").toString("utf8");
  const at = text.lastIndexOf(":");
  if (at <= 0) throw new CursorError("cursor is malformed");
  const timestamp = Number(text.slice(0, at));
  const evaluationId = text.slice(at + 1).toLowerCase();
  if (!Number.isFinite(timestamp) || !/^0x[0-9a-f]{64}$/.test(evaluationId)) {
    throw new CursorError("cursor is malformed");
  }
  return { timestamp, evaluationId };
}

/**
 * Order newest-verified first, then by id; then take a page.
 *
 * The comparator is total — id is unique per (chainId, trialId, runHash) — so two runs of the
 * same set produce the same sequence, which is the property `GATE-EVAL-08` asserts by walking
 * every page and counting rows without duplicates or gaps.
 */
export function pageEvaluations(
  all: EvaluationRecord[],
  opts: { cursor?: string | null; limit?: number } = {},
): EvaluationPage {
  const limit = Math.min(Math.max(opts.limit ?? DEFAULT_PAGE, 1), MAX_PAGE);
  const sorted = [...all].sort((a, b) => {
    if (a.identity.timestamp !== b.identity.timestamp) return b.identity.timestamp - a.identity.timestamp;
    return a.evaluationId.toLowerCase().localeCompare(b.evaluationId.toLowerCase());
  });

  let start = 0;
  if (opts.cursor) {
    const after = decodeCursor(opts.cursor);
    start = sorted.findIndex(
      (r) =>
        r.identity.timestamp < after.timestamp ||
        (r.identity.timestamp === after.timestamp && r.evaluationId.toLowerCase() > after.evaluationId),
    );
    if (start === -1) start = sorted.length;
  }

  const slice = sorted.slice(start, start + limit);
  const last = slice.at(-1);
  const next = start + slice.length < sorted.length && last !== undefined ? encodeCursor(last) : null;
  return { records: slice, nextCursor: next, total: sorted.length };
}

function truthy(value: string | undefined): boolean {
  return value === "1" || value === "true";
}

function parseLimit(value: string | undefined): number | undefined {
  if (value === undefined || value === "") return undefined;
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1 || n > MAX_PAGE) {
    throw new CursorError(`limit must be a whole number between 1 and ${MAX_PAGE}`);
  }
  return n;
}

function findRecord(all: EvaluationRecord[], id: string): EvaluationRecord | undefined {
  const needle = id.toLowerCase();
  if (!/^0x[0-9a-f]{64}$/.test(needle)) return undefined;
  // Either handle works, because both are 32-byte hashes and a caller cannot tell them apart
  // from the URL bar. The response names which one it matched, so the ambiguity is not hidden.
  return all.find((r) => r.evaluationId.toLowerCase() === needle) ?? all.find((r) => r.runHash.toLowerCase() === needle);
}

export function evaluationRoutes(source: EvaluationSource | null): Hono {
  const app = new Hono();

  const unavailable = (c: Context) =>
    c.json({ error: "the evaluation source is not configured on this host" }, 503);

  app.get("/", (c) => {
    if (!source) return unavailable(c);
    let page;
    try {
      const agentId = c.req.query("agentId");
      if (agentId !== undefined && agentId !== "") {
        const wanted = Number(agentId);
        // A malformed id is a client bug, said as 400. Answering "no records" would let a
        // caller believe nobody had been evaluated when the query itself was nonsense.
        if (!Number.isInteger(wanted) || wanted < 1) throw new CursorError("agentId must be a positive whole number");
      }
      page = pageEvaluations(filter(source.records(), c.req.query()), {
        cursor: c.req.query("cursor"),
        limit: parseLimit(c.req.query("limit")),
      });
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : "bad request" }, 400);
    }
    return c.json({
      evaluations: page.records,
      meta: {
        count: page.records.length,
        total: page.total,
        cursor: page.nextCursor,
        orderKey: ORDER_KEY,
        eligibleOnly: truthy(c.req.query("eligibleOnly")),
      },
    });
  });

  app.get("/:id", (c) => {
    if (!source) return unavailable(c);
    const record = findRecord(source.records(), c.req.param("id"));
    if (!record) return c.json({ error: "no evaluation record answers to that id or run hash" }, 404);
    return c.json({ evaluation: record });
  });

  /**
   * The bytes behind the record, resolved through the same path a skeptic uses.
   *
   * Three states, never collapsed: configured-and-found, present-but-unreadable, and nothing
   * here. A single `null` would let a storage failure look like an absent claim, which is the
   * one thing an evidence endpoint must not do.
   */
  app.get("/:id/evidence", (c) => {
    if (!source) return unavailable(c);
    const record = findRecord(source.records(), c.req.param("id"));
    if (!record) return c.json({ error: "no evaluation record answers to that id or run hash" }, 404);

    const wanted = [
      { role: "manifest" as const, cid: record.evidence.manifestCid, digest: record.evidence.manifestDigest },
      {
        role: "verificationReport" as const,
        cid: record.evidence.verificationReportCid,
        digest: record.evidence.verificationReportDigest,
      },
    ];

    const evidence: Record<string, unknown> = {};
    for (const item of wanted) {
      if (!isCid(item.cid)) {
        evidence[item.role] = { cid: item.cid, state: "unresolved", reason: "the record names no content id" };
        continue;
      }
      const read = source.lookup(item.cid);
      switch (read.kind) {
        case "text":
          evidence[item.role] = {
            cid: item.cid,
            state: "ok",
            encoding: "utf8",
            bytes: read.text,
            // The reader re-hashes rather than trusting this endpoint's word for it. The digest
            // is echoed only so a mismatch can be reported against something named.
            digest: item.digest,
          };
          break;
        case "bytes":
          evidence[item.role] = {
            cid: item.cid,
            state: "ok",
            encoding: "base64",
            bytes: Buffer.from(read.bytes).toString("base64"),
            digest: item.digest,
          };
          break;
        case "not-pinned":
          evidence[item.role] = { cid: item.cid, state: "not-pinned", reason: "this host holds no such content" };
          break;
        case "unresolved":
        case "unreadable":
        case "corrupt":
        default:
          // Present-but-damaged and absent are different answers, and the status the client
          // gets must not collapse them: a storage fault reported as "nothing here" is how an
          // unverifiable claim starts looking like an unmade one.
          evidence[item.role] = {
            cid: item.cid,
            state: read.kind,
            reason: "reason" in read ? read.reason : undefined,
          };
      }
    }

    return c.json({ evaluationId: record.evaluationId, runHash: record.runHash, evidence });
  });

  /**
   * Every verification ever published for this run, oldest first.
   *
   * This is the answer to "did the answer change?", and it is answerable only because a
   * verification is appended rather than replaced — see `packages/argus/src/persistence.ts`.
   * A run with one entry never disagreed with itself; a run with three is worth reading.
   */
  app.get("/:id/history", (c) => {
    if (!source) return unavailable(c);
    const record = findRecord(source.records(), c.req.param("id"));
    if (!record) return c.json({ error: "no evaluation record answers to that id or run hash" }, 404);
    const entries = source.history(record.runHash);
    return c.json({
      evaluationId: record.evaluationId,
      runHash: record.runHash,
      current: record.verification.reportVersion,
      versions: entries,
    });
  });

  return app;
}

function filter(records: EvaluationRecord[], query: Record<string, string | undefined>): EvaluationRecord[] {
  const cohortId = query.cohortId;
  const agentId = query.agentId;
  const eligibleOnly = truthy(query.eligibleOnly);
  return records.filter((record) => {
    if (eligibleOnly && !record.ranking.eligible) return false;
    if (cohortId !== undefined && record.ranking.cohortId !== cohortId) return false;
    if (agentId !== undefined && agentId !== "") {
      if (record.identity.agentId !== Number(agentId)) return false;
    }
    return true;
  });
}

export const EVALUATION_MAX_PAGE = MAX_PAGE;
