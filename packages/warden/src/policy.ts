import type { ReadModel, TrialRow } from "@crucible/indexer";

/**
 * Warden — the window watcher.
 *
 * `finalize` on CrucibleTrials is permissionless: anyone may call it once a
 * window closes. Warden is simply the thing that notices, so a trial never sits
 * unsettled because nobody was watching. It holds no protocol authority — a
 * lost Warden delays settlement, it cannot prevent or corrupt it.
 *
 * The decision logic is deliberately pure and separately testable, because "when
 * may this be finalized" is where the money moves and it must be readable without
 * a chain connection.
 */

export type FinalizeReason =
  | "break-window-expired"
  | "dispute-timeout"
  | "deadline-passed-reclaim"
  | "nothing-to-do";

export interface FinalizeDecision {
  action: "finalize" | "reclaim" | "wait";
  trialId: number;
  reason: FinalizeReason;
  /** seconds until the action becomes permissible; null when it already is */
  waitSec: number | null;
}

export interface WardenConstants {
  disputeTimeoutSec: number;
  /** grace period so a chain reorg or a slow indexer cannot trigger an early tx */
  graceSec: number;
}

/** Mirrors CrucibleTrials.DISPUTE_TIMEOUT. */
export const DEFAULT_CONSTANTS: WardenConstants = {
  disputeTimeoutSec: 3 * 24 * 60 * 60,
  graceSec: 30,
};

/**
 * Decide what, if anything, can be done about a trial right now.
 *
 * Mirrors the contract's rules exactly:
 *   - Judging  → finalize once runAt + breakWindow has passed
 *   - Challenged → finalize once disputeOpenedAt + DISPUTE_TIMEOUT has passed
 *   - Assigned → the sponsor reclaims (NOT finalize; finalize would revert)
 *   - Open     → nothing to do
 *   - Settled  → nothing to do
 */
export function decide(row: TrialRow, nowSeconds: number, k: WardenConstants = DEFAULT_CONSTANTS): FinalizeDecision {
  const base = { trialId: row.id } as const;

  switch (row.status) {
    case "judging": {
      if (row.runAt === null) return { ...base, action: "wait", reason: "nothing-to-do", waitSec: null };
      const readyAt = row.runAt + row.breakWindow + k.graceSec;
      if (nowSeconds >= readyAt) {
        return { ...base, action: "finalize", reason: "break-window-expired", waitSec: 0 };
      }
      return { ...base, action: "wait", reason: "break-window-expired", waitSec: readyAt - nowSeconds };
    }

    case "challenged": {
      if (row.disputeOpenedAt === null) {
        return { ...base, action: "wait", reason: "nothing-to-do", waitSec: null };
      }
      const readyAt = row.disputeOpenedAt + k.disputeTimeoutSec + k.graceSec;
      if (nowSeconds >= readyAt) {
        return { ...base, action: "finalize", reason: "dispute-timeout", waitSec: 0 };
      }
      return { ...base, action: "wait", reason: "dispute-timeout", waitSec: readyAt - nowSeconds };
    }

    case "assigned": {
      if (nowSeconds >= row.deadline + k.graceSec) {
        return { ...base, action: "reclaim", reason: "deadline-passed-reclaim", waitSec: 0 };
      }
      return {
        ...base,
        action: "wait",
        reason: "deadline-passed-reclaim",
        waitSec: row.deadline + k.graceSec - nowSeconds,
      };
    }

    case "open":
    case "settled":
    default:
      return { ...base, action: "wait", reason: "nothing-to-do", waitSec: null };
  }
}

export function decideAll(
  model: ReadModel,
  nowSeconds: number,
  k: WardenConstants = DEFAULT_CONSTANTS,
): FinalizeDecision[] {
  return [...model.trials.values()]
    .map((t) => decide(t, nowSeconds, k))
    .filter((d) => d.action !== "wait");
}

/** Which windows a Warden should ping operators about. */
export interface Notification {
  trialId: number;
  kind: "break-window-opened" | "break-window-closing" | "verdict-landed" | "dispute-opened";
  message: string;
}

const CLOSING_SOON_SEC = 60 * 60;

export function notifications(model: ReadModel, nowSeconds: number): Notification[] {
  const out: Notification[] = [];
  for (const t of model.trials.values()) {
    if (t.status === "judging" && t.runAt !== null) {
      out.push({
        trialId: t.id,
        kind: "break-window-opened",
        message: `Trial ${t.id}: skeptics may strike until the window closes.`,
      });
      const left = t.runAt + t.breakWindow - nowSeconds;
      if (left > 0 && left <= CLOSING_SOON_SEC) {
        out.push({
          trialId: t.id,
          kind: "break-window-closing",
          message: `Trial ${t.id}: the skeptic window closes in ${Math.ceil(left / 60)} minutes.`,
        });
      }
    }
    if (t.status === "challenged") {
      out.push({
        trialId: t.id,
        kind: "dispute-opened",
        message: `Trial ${t.id}: a skeptic filed a break. Argus holds the tongs.`,
      });
    }
    if (t.status === "settled" && t.verdict !== "none") {
      out.push({
        trialId: t.id,
        kind: "verdict-landed",
        message: `Trial ${t.id}: ${t.verdict}.`,
      });
    }
  }
  return out;
}

export interface Notifier {
  send(n: Notification): Promise<void>;
}

export async function notifyAll(notifier: Notifier, ns: Notification[]): Promise<void> {
  // A failed webhook must not stop the others.
  await Promise.allSettled(ns.map((n) => notifier.send(n)));
}
