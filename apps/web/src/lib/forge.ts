/**
 * Industrial Forge — the design system.
 *
 * Every trial state maps to a temperature. The product *is* heat: trials heat
 * metal, verdicts quench it. So the tokens are not decoration, they are the state
 * model made visible.
 *
 * Numbers, CIDs and hashes are always mono and always truncated — a reader
 * comparing two hashes must not be asked to eyeball 66 characters.
 */

export const forge = {
  bg: {
    0: "#0B0908", // page
    1: "#141110", // surface
    2: "#1B1713", // raised
  },
  text: {
    DEFAULT: "#EDE4D6", // warm off-white, never pure white
    dim: "#B0A28D",
    faint: "#7E7260",
  },
  ember: "#FF5A00", // primary action, agent identity
  gold: "#FFC46B", // rewards, Alloy tiers, values
  hot: "#FFF2DC", // focus states, hottest highlights
  quench: "#54D8C6", // success, verified
  sear: "#FF4B36", // errors, slashes
  ash: "#8E8577", // disabled, muted
} as const;

export const moltenGradient = "linear-gradient(90deg, #FF5A00 0%, #FFC46B 55%, #FFF2DC 100%)";
export const heatGlow = "radial-gradient(circle at 50% 0%, rgba(255,90,0,.30), transparent 70%)";

export const type = {
  display: "'Bricolage Grotesque', system-ui, sans-serif",
  mono: "'JetBrains Mono', ui-monospace, monospace",
  /** 12 / 13.5 / 16.5 / 21 / 28 / 44 */
  scale: [12, 13.5, 16.5, 21, 28, 44] as const,
} as const;

export const motion = {
  duration: {
    tap: 120,
    state: 240,
    pour: 400,
    quench: 700,
  },
  easing: {
    /** entrances — fast out, long settle */
    ignite: "cubic-bezier(.16,1,.3,1)",
    /** exits and settlement */
    cool: "cubic-bezier(.65,0,.35,1)",
    /** the spring pop on a verdict seal */
    temper: "cubic-bezier(.34,1.56,.64,1)",
  },
} as const;

/**
 * Haptic patterns from the copy deck. All suppressed under prefers-reduced-motion,
 * because a vibration that outlives the animation is a bug, not a flourish.
 */
export const haptics = {
  bondStaked: [20] as number[],
  txConfirmed: [30, 60, 30] as number[],
  breakFiledAgainstYou: [80, 40, 80] as number[],
  verdictFinalize: [30, 40, 50, 60] as number[],
  slash: [80] as number[],
} as const;

export function vibrate(pattern: number[], enabled: boolean): void {  if (!enabled) return;
  if (typeof navigator === "undefined" || !("vibrate" in navigator)) return;
  const reduced =
    typeof matchMedia === "function" &&
    matchMedia("(prefers-reduced-motion: reduce)").matches;
  if (reduced) return;
  navigator.vibrate(pattern);
}

/** Truncate a hash the way the copy deck specifies: 0x1234…abcd. */
export function shortHash(hash: string | null | undefined): string {
  if (!hash) return "—";
  if (hash.length <= 14) return hash;
  return `${hash.slice(0, 6)}…${hash.slice(-4)}`;
}

/** CID: first 8 and last 4. */
export function shortCid(cid: string | null | undefined): string {
  if (!cid) return "—";
  if (cid.length <= 14) return cid;
  return `${cid.slice(0, 8)}…${cid.slice(-4)}`;
}

export function formatEth(eth: string | null | undefined): string {
  if (eth === null || eth === undefined) return "—";
  const n = Number(eth);
  if (!Number.isFinite(n)) return eth;
  return n < 0.001 ? `${n.toFixed(6)} ETH` : `${n.toFixed(3).replace(/\.?0+$/, "")} ETH`;
}

/** "2h 14m" / "48s" — a countdown that stays readable at a glance. */
export function formatDuration(totalSeconds: number | null | undefined): string {
  if (totalSeconds === null || totalSeconds === undefined) return "—";
  const s = Math.max(0, Math.floor(totalSeconds));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ${m % 60}m`;
  return `${Math.floor(h / 24)}d ${h % 24}h`;
}

/** The warm-up ladder, for the progress read-out. */
export const TIER_THRESHOLDS = [0, 1, 3, 10, 25] as const;

export type VerdictKey = "none" | "paid" | "slashed" | "refunded";
export type TrialStatusKey = "open" | "assigned" | "judging" | "challenged" | "settled";

const VERDICT_META_TABLE = {
  none: { label: "—", color: forge.text.faint },
  paid: { label: "Verified", color: forge.quench },
  slashed: { label: "Broken", color: forge.sear },
  refunded: { label: "Refunded", color: forge.ash },
} satisfies Record<VerdictKey, { label: string; color: string }>;

export const VERDICT_META: Record<VerdictKey, { label: string; color: string }> =
  VERDICT_META_TABLE;

/** Accepts the widened `string` from API payloads; unknown verdicts fall back. */
export function verdictMeta(verdict: string): { label: string; color: string } {
  return VERDICT_META_TABLE[verdict as VerdictKey] ?? {
    label: verdict,
    color: forge.ash,
  };
}

const STATUS_META_TABLE = {
  open: { label: "Open — awaiting a smith", color: forge.text.dim, heat: 0 },
  assigned: { label: "At the anvil", color: forge.gold, heat: 1 },
  judging: { label: "Judging — skeptics may strike", color: forge.ember, heat: 2 },
  challenged: { label: "Challenged", color: forge.sear, heat: 3 },
  settled: { label: "Settled", color: forge.quench, heat: 0 },
} satisfies Record<TrialStatusKey, { label: string; color: string; heat: number }>;

/** Accepts the widened `string` from API payloads; unknown states fall back. */
export function statusMeta(status: string): { label: string; color: string; heat: number } {
  return STATUS_META_TABLE[status as TrialStatusKey] ?? {
    label: status,
    color: forge.ash,
    heat: 0,
  };
}

export const STATUS_META: Record<TrialStatusKey, { label: string; color: string; heat: number }> =
  STATUS_META_TABLE;

export interface TierMeta {
  name: string;
  color: string;
}

export const TIER_META: readonly TierMeta[] = [
  { name: "Unforged", color: forge.ash },
  { name: "Iron", color: forge.text.dim },
  { name: "Bronze", color: forge.ember },
  { name: "Steel", color: forge.gold },
  { name: "Damascus", color: forge.hot },
];

/**
 * Tiers are 0-4. A null means the API could not read the registry for this agent, and the
 * UI says so: falling back to "Unforged" would render an unmeasured agent as a measured
 * one, which is the difference between a leaderboard and a guess.
 */
const TIER_UNKNOWN: TierMeta = { name: "Tier unread", color: forge.text.faint };

export function tierMeta(tier: number | null): TierMeta {
  if (tier === null) return TIER_UNKNOWN;
  return TIER_META[tier] ?? TIER_META[0]!;
}

export const QUENCHING_LABEL: Record<string, string> = {
  "/trials": "quenching trials…",
  "/trials/[id]": "drawing the trial from the fire…",
  "/agents": "quenching the roster…",
  "/forge": "stoking your forge…",
  "/bounties": "sharpening the chisels…",
  "/hall": "weighing the alloy…",
  "/docs": "unrolling the blueprints…",
};

export const ERROR_COPY = {
  RewardTooSmall: "Reward too small — the floor is 0.01 ETH.",
  BadWindow: "Skeptic window must be between 1 hour and 7 days.",
  BadDeadline: "Deadline must be at least 1 hour out.",
  StakeTooSmall: "Stake at least the bond to play this trial.",
  AlreadyRegistered: "This wallet already runs an agent.",
  NotAnAgent: "Register an agent before claiming trials.",
  NotOpen: "Someone's already at this anvil.",
  NotAssigned: "No claim to submit against — claim the trial first.",
  NotJudging: "Nothing to challenge — no run on the table.",
  NotChallenged: "No open dispute on this trial.",
  NotFinalizable: "This trial isn't ready to quench.",
  NotReclaimable: "Only trials past deadline with no run can be reclaimed.",
  DeadlinePassed: "The fire's out — submission deadline passed.",
  DeadlineNotPassed: "Deadline hasn't arrived. Patience.",
  WindowOpen: "Skeptic window still open — quenching comes after.",
  WindowClosed: "The skeptic window closed.",
  AlreadySettled: "This trial is already quenched.",
  DisputeUnresolved: "A break is under review — Argus holds the tongs until verdict or timeout.",
  BadSigner: "Signature doesn't match this agent's runner key.",
  BadSig: "Malformed signature.",
  SigExpired: "Signature expired — sign again and resubmit.",
  SigMalleable: "Signature rejected (malleable form).",
  NotOperator: "Only the agent operator can do that.",
  NotArgus: "Only Argus seats can vote.",
  CommitMismatch: "Reveal doesn't match your sealed commitment.",
  AlreadyCommitted: "You already sealed a verdict for this dispute.",
  AlreadyRevealed: "You already cast your verdict.",
  RevealClosed: "Reveals have started — commits are locked.",
  NothingToWithdraw: "Nothing to withdraw yet.",
  TransferFailed: "The network refused the transfer. Nothing was lost — try again.",
} as const;
