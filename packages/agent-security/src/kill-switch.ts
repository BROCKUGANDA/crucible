/**
 * @file kill-switch.ts — Off-chain new-run kill switch.
 *
 * Blocks creation of new evaluations and other risky off-chain work, while
 * leaving in-flight settlement, withdrawals, and all on-chain settlement
 * paths untouched. The kill switch is an operational control, not a contract
 * change: it cannot move money, cannot alter fee schedules, and cannot
 * reverse a settlement.
 *
 * State is held in memory (consistent with ADR-0008). A multi-process
 * deployment shares this via a coordinated backing store without changing
 * the interface.
 *
 * The switch fails closed: when the store is unavailable, new risky work is
 * rejected. Settlement never depends on this store (ADR-0003,
 * collaboration-and-governance.md §1).
 */

const STATE_KEY = "__crucible_kill_switch__";
const globalScope = globalThis as unknown as Record<string, unknown>;

type KillSwitchStore = {
  enabled: boolean;
  enabledAt: number | null;
  enabledBy: string | null;
  reason: string | null;
  /** every state transition, append-only */
  history: KillSwitchEvent[];
};

function getStore(): KillSwitchStore {
  let store = globalScope[STATE_KEY] as KillSwitchStore | undefined;
  if (!store) {
    store = {
      enabled: false,
      enabledAt: null,
      enabledBy: null,
      reason: null,
      history: [],
    };
    globalScope[STATE_KEY] = store;
  }
  return store;
}

export interface KillSwitchEvent {
  at: number;
  actor: string;
  action: "enable" | "disable";
  reason: string | null;
  previous: boolean;
  next: boolean;
}

export interface KillSwitchStatus {
  enabled: boolean;
  enabledAt: number | null;
  enabledBy: string | null;
  reason: string | null;
  historyCount: number;
}

/**
 * Enable the kill switch. Rejects new evaluations and risky off-chain work.
 * Settlement, withdrawals, and on-chain finalization are unaffected.
 */
export function enable(actor: string, reason: string): KillSwitchStatus {
  const store = getStore();
  if (store.enabled) {
    return status(store);
  }
  const event: KillSwitchEvent = {
    at: Date.now(),
    actor,
    action: "enable",
    reason,
    previous: false,
    next: true,
  };
  store.enabled = true;
  store.enabledAt = event.at;
  store.enabledBy = actor;
  store.reason = reason;
  store.history.push(event);
  return status(store);
}

/**
 * Disable the kill switch. Requires the same actor who enabled it, or a
 * platform operator, to recover in a controlled way.
 */
export function disable(actor: string, reason: string): KillSwitchStatus {
  const store = getStore();
  if (!store.enabled) {
    return status(store);
  }
  const event: KillSwitchEvent = {
    at: Date.now(),
    actor,
    action: "disable",
    reason,
    previous: true,
    next: false,
  };
  store.enabled = false;
  store.enabledAt = null;
  store.enabledBy = null;
  store.reason = null;
  store.history.push(event);
  return status(store);
}

/** Current kill switch status. */
export function status(store?: KillSwitchStore): KillSwitchStatus {
  const s = store ?? getStore();
  return {
    enabled: s.enabled,
    enabledAt: s.enabledAt,
    enabledBy: s.enabledBy,
    reason: s.reason,
    historyCount: s.history.length,
  };
}

/** Full history of state transitions (audit trail). */
export function history(): KillSwitchEvent[] {
  return [...getStore().history];
}

/**
 * Whether new risky work (evaluation creation, batch submission, deployment
 * of new off-chain jobs) should be rejected. Settlement-related actions
 * (withdraw, finalize, reclaimExpired) always return false — they are not
 * blocked by the kill switch.
 */
export function isBlocked(action: "new_evaluation" | "batch_submit" | "deploy_job" | "withdraw" | "finalize" | "reclaim"): boolean {
  const s = getStore();
  // Settlement and withdrawal actions are never blocked by the kill switch.
  if (action === "withdraw" || action === "finalize" || action === "reclaim") {
    return false;
  }
  return s.enabled;
}

/**
 * Assert that an action is not blocked. Throws when the kill switch is
 * enabled for non-settlement actions.
 */
export function assertNotBlocked(action: Exclude<keyof ReturnType<typeof isBlocked>, "withdraw" | "finalize" | "reclaim">): void {
  if (isBlocked(action as never)) {
    const s = status();
    throw new Error(
      `kill switch enabled: ${action} is blocked (since ${new Date(s.enabledAt ?? 0).toISOString()}, ${s.reason ?? "no reason recorded"})`,
    );
  }
}

/** Reset store state (testing only). */
export function __resetKillSwitchForTests(): void {
  const store = getStore();
  store.enabled = false;
  store.enabledAt = null;
  store.enabledBy = null;
  store.reason = null;
  store.history = [];
}

/** TypeScript brand. */
export const __killSwitchBrand = Symbol.for("crucible.kill-switch");