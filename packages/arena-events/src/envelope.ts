/**
 * The ArenaEvent envelope (bible §16.10).
 *
 * One typed event stream is shared by House Bouts, Ghost Runs, Replay Theater and the
 * live arena, so a single room renderer and a single commentator serve every mode. The
 * envelope is pure data: no chain reads, no clock, no model. `at` is display-only and is
 * never hashed into a verdict.
 */

export const ARENA_EVENT_VERSION = 1 as const;

export const ARENA_MODES = ["live", "showcase", "ghost", "replay"] as const;
export type ArenaMode = (typeof ARENA_MODES)[number];

export const ARENA_STAGES = ["I", "II", "III", "IV", "V", "VI", "VII"] as const;
export type ArenaStage = (typeof ARENA_STAGES)[number];

export const ARENA_ACTOR_ROLES = [
  "sponsor",
  "agent",
  "skeptic",
  "seat",
  "crank",
  "house",
] as const;
export type ArenaActorRole = (typeof ARENA_ACTOR_ROLES)[number];

export interface ArenaActor {
  role: ArenaActorRole;
  handle: string;
}

export const ARENA_EVENT_KINDS = [
  "trial.posted",
  "claim.accepted",
  "run.step",
  "run.test",
  "run.replay",
  "sandbox.blocked",
  "run.attested",
  "window.opened",
  "break.committed",
  "window.closed",
  "break.revealed",
  "docket.frozen",
  "panel.drawn",
  "vote.committed",
  "vote.revealed",
  "verdict.settled",
  "money.moved",
  "standing.changed",
  "favor.split",
  "commentary",
] as const;
export type ArenaEventKind = (typeof ARENA_EVENT_KINDS)[number];

export const CHAIN_COMMITMENTS = ["confirmed", "finalized"] as const;
export type ChainCommitment = (typeof CHAIN_COMMITMENTS)[number];

export interface ChainRef {
  caip2: string;
  tx: string;
  slotOrBlock: number;
  commitment: ChainCommitment;
}

export interface ArenaEvent {
  v: typeof ARENA_EVENT_VERSION;
  id: string;
  mode: ArenaMode;
  trial: string;
  stage: ArenaStage;
  kind: ArenaEventKind;
  actor?: ArenaActor;
  payload: Record<string, unknown>;
  chainRef?: ChainRef;
  at: string;
}

export interface ValidationResult {
  ok: boolean;
  errors: string[];
}

const ID_RE = /^[A-Za-z0-9._:-]{1,200}$/;
const HANDLE_RE = /^[A-Za-z0-9._-]{1,64}$/;
const CAIP2_RE = /^[a-z0-9-]+:[A-Za-z0-9]+$/;

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

export function validateArenaEvent(value: unknown): ValidationResult {
  const errors: string[] = [];
  if (!isPlainObject(value)) {
    return { ok: false, errors: ["event must be an object"] };
  }
  const e = value as Record<string, unknown>;

  if (e.v !== ARENA_EVENT_VERSION) errors.push("v must be 1");
  if (typeof e.id !== "string" || !ID_RE.test(e.id)) errors.push("id must be a non-empty id string");
  if (typeof e.mode !== "string" || !ARENA_MODES.includes(e.mode as ArenaMode))
    errors.push("mode must be one of " + ARENA_MODES.join(", "));
  if (typeof e.trial !== "string" || e.trial.length === 0) errors.push("trial must be a non-empty string");
  if (typeof e.stage !== "string" || !ARENA_STAGES.includes(e.stage as ArenaStage))
    errors.push("stage must be one of " + ARENA_STAGES.join(", "));
  if (typeof e.kind !== "string" || !ARENA_EVENT_KINDS.includes(e.kind as ArenaEventKind))
    errors.push("kind must be one of " + ARENA_EVENT_KINDS.join(", "));
  if (!isPlainObject(e.payload)) errors.push("payload must be an object");

  if (e.actor !== undefined) {
    if (!isPlainObject(e.actor)) errors.push("actor must be an object");
    else {
      const a = e.actor as Record<string, unknown>;
      if (typeof a.role !== "string" || !ARENA_ACTOR_ROLES.includes(a.role as ArenaActorRole))
        errors.push("actor.role must be a known role");
      if (typeof a.handle !== "string" || !HANDLE_RE.test(a.handle))
        errors.push("actor.handle must be a short handle");
    }
  }

  if (e.chainRef !== undefined) {
    if (!isPlainObject(e.chainRef)) errors.push("chainRef must be an object");
    else {
      const c = e.chainRef as Record<string, unknown>;
      if (typeof c.caip2 !== "string" || !CAIP2_RE.test(c.caip2)) errors.push("chainRef.caip2 must be CAIP-2");
      if (typeof c.tx !== "string" || c.tx.length === 0) errors.push("chainRef.tx must be non-empty");
      if (typeof c.slotOrBlock !== "number" || !Number.isInteger(c.slotOrBlock) || c.slotOrBlock < 0)
        errors.push("chainRef.slotOrBlock must be a non-negative integer");
      if (typeof c.commitment !== "string" || !CHAIN_COMMITMENTS.includes(c.commitment as ChainCommitment))
        errors.push("chainRef.commitment must be confirmed or finalized");
    }
  }

  if (typeof e.at !== "string" || e.at.length === 0) errors.push("at must be a non-empty display string");

  return { ok: errors.length === 0, errors };
}

export function isArenaEvent(value: unknown): value is ArenaEvent {
  return validateArenaEvent(value).ok;
}

/**
 * Canary scan: sealed data (holdout ids, salts, sealed break types, unrevealed votes)
 * must never appear in any string field of an event or its payload. Returns the list of
 * canary strings found (empty = clean).
 */
export function findCanaries(value: unknown, canaries: readonly string[]): string[] {
  const found = new Set<string>();
  const visit = (v: unknown): void => {
    if (typeof v === "string") {
      for (const c of canaries) {
        if (c.length > 0 && v.includes(c)) found.add(c);
      }
    } else if (Array.isArray(v)) {
      for (const item of v) visit(item);
    } else if (isPlainObject(v)) {
      for (const k of Object.keys(v)) visit(k);
      for (const val of Object.values(v)) visit(val);
    }
  };
  visit(value);
  return [...found];
}
