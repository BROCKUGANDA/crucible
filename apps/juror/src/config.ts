import path from "node:path";
import type { Address } from "viem";
import { privateKeyToAccount } from "viem/accounts";

/**
 * Configuration, and the refusals that go with it.
 *
 * Four variables are load-bearing and none of them has a default: an RPC, the contract, the
 * seat's key, and where the pinned content lives. A wrong one of those is not a degraded
 * service, it is a service that signs with somebody else's authority or votes on evidence it
 * never read, so every one of them is required rather than guessed at.
 *
 * `SEAT_PRIVATE_KEY` in particular gets no fallback. The keeper next door may use Anvil's
 * published dev key #0, and only after proving to a loopback node that the chain is the local
 * demo (`apps/keeper/src/main.ts`'s `resolveKeeperAccount`). A seat cannot claim the same
 * licence: `isArgus` grants three addresses on the demo chain and those are Anvil accounts
 * #1-#3, whose keys are in the same public list, so any code path that "just uses a dev key"
 * would be a path an operator can select by forgetting a variable — and a seat that votes is
 * signing a verdict that moves a bond, not relaying a transaction.
 */

/** The switch an operator pulls to stop this seat voting is `juror.vote` — see `patrol.ts`. */

export interface JurorConfig {
  rpcUrl: string;
  trialsAddress: Address;
  /** the seat's voting account; `.address` is public, `.signMessage` is not */
  account: ReturnType<typeof privateKeyToAccount>;
  /** the directory-addressed content store `scripts/seed-content.mjs` writes */
  contentDir: string;
  /** where this seat's sealed salts live — see `state.ts` for why that is a separate directory */
  stateDir: string;
  /** how often the operator takes a pass */
  patrolMs: number;
  /** how long a trial that abstained waits before the suite is re-run for it */
  reverifyMs: number;
  port: number;
  fromBlock: bigint | null;
  cursorFile: string | undefined;
}

/**
 * A missing variable is named, not described. Empty counts as missing because that is what
 * compose hands over when the operator left the line blank in `.env` — `${SEAT_PRIVATE_KEY:-}`
 * arrives as "", and a check that only looks for `undefined` lets it through to viem.
 */
function required(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name]?.trim();
  if (!value) throw new Error(`juror refusing to start: ${name} is required and is unset or empty`);
  return value;
}

function positiveInt(env: NodeJS.ProcessEnv, name: string, fallback: number): number {
  const raw = env[name]?.trim();
  if (!raw) return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`juror refusing to start: ${name} must be a positive number of milliseconds (got "${raw}")`);
  }
  return parsed;
}

export function readConfig(env: NodeJS.ProcessEnv = process.env): JurorConfig {
  const rpcUrl = required(env, "RPC_URL");
  const trials = required(env, "TRIALS_ADDRESS");
  if (!/^0x[0-9a-fA-F]{40}$/.test(trials)) {
    throw new Error(`juror refusing to start: TRIALS_ADDRESS "${trials}" is not a 20-byte hex address`);
  }

  const key = required(env, "SEAT_PRIVATE_KEY");
  if (!/^0x[0-9a-fA-F]{64}$/.test(key)) {
    // The value is deliberately not quoted here. A malformed key is more likely to be a paste
    // of something real than to be nothing at all, and a stack trace is a log line.
    throw new Error("juror refusing to start: SEAT_PRIVATE_KEY must be 32 bytes as 0x-prefixed hex");
  }

  const contentDir = path.resolve(required(env, "CONTENT_DIR"));
  const rawFrom = env.FROM_BLOCK?.trim();
  let fromBlock: bigint | null = null;
  if (rawFrom) {
    try {
      fromBlock = BigInt(rawFrom);
    } catch {
      throw new Error(`juror refusing to start: FROM_BLOCK "${rawFrom}" is not an integer`);
    }
  }

  return {
    rpcUrl,
    trialsAddress: trials as Address,
    account: privateKeyToAccount(key as `0x${string}`),
    contentDir,
    // Beside the store, never inside it. `state.ts` writes seat secrets here; the content
    // directory is a bind-mounted host path that the pinning one-shot also writes, and the
    // two should not be recoverable from the same backup or wiped by the same `rm -rf`.
    stateDir: path.resolve(env.STATE_DIR?.trim() || path.join(contentDir, "..", "juror-state")),
    patrolMs: positiveInt(env, "PATROL_MS", 30_000),
    reverifyMs: positiveInt(env, "REVERIFY_MS", 15 * 60_000),
    port: positiveInt(env, "PORT", 8790),
    fromBlock,
    cursorFile: env.CRUSIBLE_CURSOR_FILE?.trim() || undefined,
  };
}
