import type { Address, Hash, PublicClient, WalletClient } from "viem";
import {
  ARENA_ABI,
  BREAK_REVEAL_GRACE_SECONDS,
  VOTE_COMMIT_WINDOW_SECONDS,
  VOTE_REVEAL_WINDOW_SECONDS,
} from "@crucible/smith";

/**
 * The arena's permissionless cranks, driven.
 *
 * `Arena` is deliberately built so every state has an exit that needs no privilege: `expireTrial`,
 * `claimTimeout`, `freezeDocket`, `drawPanel` and `tally` can all be sent by any funded account,
 * and the contract refuses the ones that are early. Nothing in this repository sent them, so a
 * trial that reached `Docketed` or `Panel` stood there until a human typed a transaction.
 *
 * This module decides which are due and sends them. It does not decide *whether* they are allowed:
 * every precondition is repeated in the contract, and a wrong answer here is a reverted
 * transaction that costs gas and changes nothing. The checks exist to avoid paying that gas.
 *
 * `revealHoldout` is deliberately not here: it needs the agent's holdout secret, which the keeper
 * does not and must not have. That is the agent's own act, not a crank.
 */

/** `Arena.Status`, in declaration order. */
export const ARENA_STATUS = ["Open", "Claimed", "Submitted", "Docketed", "Panel", "Settled"] as const;

export type ArenaCrankName =
  | "expireTrial"
  | "claimTimeout"
  | "freezeDocket"
  | "drawPanel"
  | "tally";

export interface ArenaAction {
  trialId: number;
  action: ArenaCrankName;
  txHash?: Hash;
  /** why the transaction was not sent, or the revert that came back */
  error?: string;
}

export interface ArenaCrankDeps {
  publicClient: PublicClient;
  wallet: WalletClient;
  arenaAddress: Address;
  /**
   * How many trials one pass will look at. A pass reads state and windows per trial, so an arena
   * with thousands of settled trials must not turn one tick into thousands of RPC reads. The
   * cursor rotates, so nothing is starved — it is a rate, not an exclusion.
   */
  maxTrialsPerTick?: number;
  onLog?: (line: string) => void;
}

type StateTuple = readonly [number, number, number, boolean, boolean, boolean];
type WindowsTuple = readonly [bigint, bigint, bigint, bigint, bigint, bigint, number];

/** The phase each trial is in, then the one crank that moves it. */
export function dueCrank(args: {
  status: number;
  round: number;
  windows: WindowsTuple;
  panelDrawnAt: bigint;
  now: bigint;
  grace: bigint;
  commit: bigint;
  reveal: bigint;
}): { action: ArenaCrankName; round?: number } | null {
  const { status, round, windows, panelDrawnAt, now, grace, commit, reveal } = args;
  const openUntil = windows[1];
  const claimDeadline = windows[2];
  const windowEnd = windows[4];

  if (status === 0 && now >= openUntil) return { action: "expireTrial" };
  if (status === 1 && now >= claimDeadline) return { action: "claimTimeout" };
  if (status === 2 && now >= windowEnd + grace) return { action: "freezeDocket" };
  if (status === 3 && panelDrawnAt === 0n) return { action: "drawPanel", round };
  // `tally` reverts while the window is still open (`now <= drawnAt + commit + reveal`), so the
  // comparison is strict on both sides.
  if (status === 4 && panelDrawnAt > 0n && now > panelDrawnAt + commit + reveal) {
    return { action: "tally" };
  }
  return null;
}

export function createArenaCrank(deps: ArenaCrankDeps): {
  act: (now: bigint) => Promise<{ acted: ArenaAction[] }>;
} {
  const read = <T>(functionName: string, args: readonly unknown[]): Promise<T> =>
    deps.publicClient.readContract({
      address: deps.arenaAddress,
      abi: ARENA_ABI,
      // The generated ABI is untyped JSON; the shapes are asserted at the call sites below.
      functionName: functionName as never,
      args: args as never,
    }) as Promise<T>;

  const send = async (trialId: number, action: ArenaCrankName, round?: number): Promise<ArenaAction> => {
    try {
      const txHash = (await deps.wallet.writeContract({
        address: deps.arenaAddress,
        abi: ARENA_ABI,
        functionName: action,
        args: action === "drawPanel" ? [BigInt(trialId), round] : [BigInt(trialId)],
        // The ABI is generated and its names are literal, but this call's name is chosen at
        // runtime from `dueCrank`; TypeScript cannot resolve a union of names against one
        // overload. viem still validates the selector and the argument shapes at the boundary.
      } as never)) as Hash;
      deps.onLog?.(`arena ${action} #${trialId} ${txHash}`);
      return { trialId, action, txHash };
    } catch (err) {
      // One trial's revert must not stop the rest: the contract is the authority, and a race
      // with another crank is the expected way for this to fail.
      const message = (err as { shortMessage?: string; message?: string }).shortMessage
        ?? (err as Error).message;
      deps.onLog?.(`arena ${action} #${trialId} refused: ${message}`);
      return { trialId, action, error: message };
    }
  };

  let cursor = 1;

  return {
    async act(now) {
      const total = Number(await read<bigint>("trialCount", []));
      if (!Number.isFinite(total) || total < 1) return { acted: [] };

      const budget = Math.min(total, deps.maxTrialsPerTick ?? 64);
      const acted: ArenaAction[] = [];

      for (let n = 0; n < budget; n++) {
        const id = ((cursor - 1 + n) % total) + 1;
        const state = await read<StateTuple>("stateOf", [BigInt(id)]);
        const status = Number(state[0]);
        if (status === 5) continue; // Settled is terminal; nothing to crank.

        const round = Number(state[2]);
        const windows = await read<WindowsTuple>("windowsOf", [BigInt(id)]);
        const panelDrawnAt =
          status === 3 || status === 4
            ? await read<bigint>("panelDrawnAt", [BigInt(id), round])
            : 0n;

        const due = dueCrank({
          status,
          round,
          windows,
          panelDrawnAt,
          now,
          grace: BREAK_REVEAL_GRACE_SECONDS,
          commit: VOTE_COMMIT_WINDOW_SECONDS,
          reveal: VOTE_REVEAL_WINDOW_SECONDS,
        });
        if (due) acted.push(await send(id, due.action, due.round));
      }

      cursor = ((cursor - 1 + budget) % total) + 1;
      return { acted };
    },
  };
}
