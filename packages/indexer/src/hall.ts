/**
 * @file hall.ts — the log-driven hall index, ported from the merged Scaffold-ETH 2
 * build (`services/hall/resilientDSabiller.ts`).
 *
 * It answers a question the Scribe read model deliberately does not: what does the
 * Hall look like to a reader with nothing but a chain — no API, no database, no
 * server? `CrucibleHall` (the contract this reads) exists for exactly that reader.
 *
 * What the port changed, and why:
 *
 *   - **Nothing module-level reads `process.env`.** This package is the pure read
 *     layer of the monorepo; the chain, the RPC and the deployment address arrive
 *     through the constructor so the API host — the only process allowed to know
 *     them — owns them. The SE-2 original read env at import time, which made it
 *     untestable without a chain and un-mockable without a loader.
 *   - **The self-scheduling loop is kept** (a `setTimeout` re-armed after each tick,
 *     never `setInterval`): overlapping ticks on a slow RPC would apply the same log
 *     range twice, and the repair path below assumes at most one tick in flight.
 *   - **The repair path is kept**: chain restarts rebuild the index from logs, and
 *     every tenth consecutive failure rewinds to the deployment block for a full
 *     rescan. A poller that only ever moves forward is one missed log away from a
 *     hall that silently omits a settlement.
 */
import { createPublicClient, formatEther, http, parseAbiItem, type PublicClient } from "viem";
import type { Chain } from "viem";

export type ChainHallIdentity = {
  account: string;
  handle: string;
  linkedAt: number;
  updatedAt: number;
  txHash: string | null;
  blockNumber: number | null;
};

export type ChainHallTrial = {
  trialId: number;
  settler: string;
  contestant: string;
  stakeWei: bigint;
  openedAt: number;
  openTx: string | null;
  openBlock: number | null;
  settled: boolean;
  score: number;
  rewardWei: bigint;
  settledAt: number;
  settleTx: string | null;
  settleBlock: number | null;
};

export type ChainHallEntry = {
  rank: number;
  account: string;
  handle: string;
  identityLinkedAt: number;
  score: number;
  trialsSettled: number;
  totalRewardEth: string;
  bestTrialId: number;
  settledAt: number;
  proof: { trialId: number; txHash: string | null; blockNumber: number | null };
};

export type ChainHallSnapshot = {
  version: number;
  generatedAt: number;
  chainId: number;
  contract: string | null;
  status: "syncing" | "live" | "degraded" | "offline";
  lastSyncedBlock: number;
  error: string | null;
  stats: { identities: number; trialsOpened: number; trialsSettled: number; distributedEth: string };
  entries: ChainHallEntry[];
  openTrials: {
    trialId: number;
    contestant: string;
    handle: string;
    stakeEth: string;
    openedAt: number;
    txHash: string | null;
  }[];
};

const EVENT_ABI = [
  parseAbiItem("event IdentityLinked(address indexed account, string handle, uint64 at)"),
  parseAbiItem("event IdentityUpdated(address indexed account, string previousHandle, string newHandle, uint64 at)"),
  parseAbiItem(
    "event TrialOpened(uint256 indexed trialId, address indexed settler, address indexed contestant, uint256 stake, uint64 at)",
  ),
  parseAbiItem(
    "event TrialSettled(uint256 indexed trialId, address indexed contestant, uint256 score, uint256 reward, uint64 at)",
  ),
];

const POLL_MS = 1_500;
const BACKOFF_MAX_MS = 30_000;
const RESYNC_EVERY_FAILURES = 10;
const LOG_CHUNK = 4_000n;

type RawLog = {
  eventName: string;
  args: Record<string, unknown>;
  transactionHash: string | null;
  blockNumber: bigint | null;
};

type Subscriber = (snapshot: ChainHallSnapshot) => void;

export interface ChainHallIndexOptions {
  chain: Chain;
  rpcUrl: string;
  /** CrucibleHall deployment. Null means "not deployed here" — the index stays offline rather than guessing. */
  deployment: { address: `0x${string}`; deployedOnBlock?: number } | null;
  /** Injectable for tests; defaults to a live client over `rpcUrl`. */
  client?: PublicClient;
}

export class HallIndex {
  private identities = new Map<string, ChainHallIdentity>();
  private trials = new Map<number, ChainHallTrial>();
  private subscribers = new Set<Subscriber>();
  private timer: ReturnType<typeof setTimeout> | null = null;
  private running = false;
  private failures = 0;
  private version = 0;
  private lastSyncedBlock = -1;
  private status: ChainHallSnapshot["status"] = "syncing";
  private lastError: string | null = null;
  private readyPromise: Promise<void> | null = null;
  private resolveReady: (() => void) | null = null;

  readonly client: PublicClient;

  constructor(private readonly opts: ChainHallIndexOptions) {
    this.client = opts.client ?? createPublicClient({ chain: opts.chain, transport: http(opts.rpcUrl) });
  }

  /** Lazily boots the poll loop on first interest (snapshot GET or SSE). */
  ensureRunning(): void {
    if (this.running) return;
    this.running = true;
    this.readyPromise = new Promise((resolve) => {
      this.resolveReady = resolve;
    });
    this.schedule(0);
  }

  subscribe(subscriber: Subscriber): () => void {
    this.subscribers.add(subscriber);
    this.ensureRunning();
    return () => {
      this.subscribers.delete(subscriber);
    };
  }

  stop(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.running = false;
  }

  /** Awaits the first sync attempt so callers never see a cold empty index. */
  async getSnapshot(): Promise<ChainHallSnapshot> {
    this.ensureRunning();
    if (this.readyPromise) await this.readyPromise;
    return this.buildSnapshot();
  }

  private markReady(): void {
    this.resolveReady?.();
    this.resolveReady = null;
    this.readyPromise = null;
  }

  private schedule(delayMs: number): void {
    this.timer = setTimeout(() => void this.tick(), delayMs);
  }

  private async tick(): Promise<void> {
    const nextDelay =
      this.failures === 0 ? POLL_MS : Math.min(POLL_MS * 2 ** Math.min(this.failures, 5), BACKOFF_MAX_MS);
    let changed = false;

    try {
      const deployment = this.opts.deployment;
      if (!deployment) throw new Error("CrucibleHall deployment missing");
      const latest = Number(await this.client.getBlockNumber());

      if (latest < this.lastSyncedBlock) {
        // Chain restarted underneath us: rebuild purely from logs.
        this.resetIndex();
        changed = true;
      }

      const from = BigInt(Math.max(this.lastSyncedBlock + 1, deployment.deployedOnBlock ?? 0));
      const to = BigInt(latest);
      if (to >= from) {
        for (let start = from; start <= to; start += LOG_CHUNK) {
          const chunkEnd = start + LOG_CHUNK - 1n > to ? to : start + LOG_CHUNK - 1n;
          const logs = (await this.client.getLogs({
            address: deployment.address,
            events: EVENT_ABI,
            fromBlock: start,
            toBlock: chunkEnd,
          })) as unknown as RawLog[];
          if (this.applyLogs(logs)) changed = true;
          this.lastSyncedBlock = Number(chunkEnd);
        }
      }

      this.failures = 0;
      if (this.status !== "live" || this.lastError) {
        this.status = "live";
        this.lastError = null;
        changed = true;
      }
    } catch (error) {
      this.failures += 1;
      this.status = this.lastSyncedBlock < 0 ? "offline" : "degraded";
      this.lastError = error instanceof Error ? error.message : "indexer error";
      if (this.failures % RESYNC_EVERY_FAILURES === 0) {
        this.lastSyncedBlock = (this.opts.deployment?.deployedOnBlock ?? 1) - 1;
      }
      changed = true;
    }

    if (changed) this.broadcast();
    this.markReady();
    this.schedule(nextDelay);
  }

  private resetIndex(): void {
    this.identities.clear();
    this.trials.clear();
    this.lastSyncedBlock = (this.opts.deployment?.deployedOnBlock ?? 1) - 1;
    this.version += 1;
  }

  /** Applies an ordered batch of logs; returns true when anything changed. */
  private applyLogs(logs: RawLog[]): boolean {
    if (logs.length === 0) return false;
    let changed = false;

    for (const log of logs) {
      const args = log.args ?? {};
      const txHash = log.transactionHash;
      const blockNumber = log.blockNumber != null ? Number(log.blockNumber) : null;

      if (log.eventName === "IdentityLinked") {
        const account = lower(args.account);
        this.identities.set(account, {
          account,
          handle: String(args.handle ?? ""),
          linkedAt: num(args.at),
          updatedAt: num(args.at),
          txHash,
          blockNumber,
        });
        changed = true;
      } else if (log.eventName === "IdentityUpdated") {
        const account = lower(args.account);
        const previous = this.identities.get(account);
        this.identities.set(account, {
          account,
          handle: String(args.newHandle ?? ""),
          linkedAt: previous?.linkedAt ?? num(args.at),
          updatedAt: num(args.at),
          txHash,
          blockNumber,
        });
        changed = true;
      } else if (log.eventName === "TrialOpened") {
        const trialId = num(args.trialId);
        this.trials.set(trialId, {
          trialId,
          settler: lower(args.settler),
          contestant: lower(args.contestant),
          stakeWei: BigInt(args.stake as string | number | bigint),
          openedAt: num(args.at),
          openTx: txHash,
          openBlock: blockNumber,
          settled: false,
          score: 0,
          rewardWei: 0n,
          settledAt: 0,
          settleTx: null,
          settleBlock: null,
        });
        changed = true;
      } else if (log.eventName === "TrialSettled") {
        const trialId = num(args.trialId);
        const trial: ChainHallTrial = this.trials.get(trialId) ?? {
          trialId,
          settler: "",
          contestant: lower(args.contestant),
          stakeWei: 0n,
          openedAt: 0,
          openTx: null,
          openBlock: null,
          settled: false,
          score: 0,
          rewardWei: 0n,
          settledAt: 0,
          settleTx: null,
          settleBlock: null,
        };
        trial.settled = true;
        trial.score = num(args.score);
        trial.rewardWei = BigInt(args.reward as string | number | bigint);
        trial.settledAt = num(args.at);
        trial.settleTx = txHash;
        trial.settleBlock = blockNumber;
        this.trials.set(trialId, trial);
        changed = true;
      }
    }

    return changed;
  }

  private broadcast(): void {
    const snapshot = this.buildSnapshot();
    for (const subscriber of this.subscribers) {
      try {
        subscriber(snapshot);
      } catch {
        // A crashing subscriber is evicted so one bad client cannot stall the stream.
        this.subscribers.delete(subscriber);
      }
    }
  }

  private buildSnapshot(): ChainHallSnapshot {
    const settledByContestant = new Map<string, ChainHallTrial[]>();
    const openTrials: ChainHallSnapshot["openTrials"] = [];
    let settledCount = 0;
    let distributedWei = 0n;

    for (const trial of this.trials.values()) {
      if (!trial.settled) {
        openTrials.push({
          trialId: trial.trialId,
          contestant: trial.contestant,
          handle: this.identities.get(trial.contestant)?.handle ?? shortAddress(trial.contestant),
          stakeEth: formatEther(trial.stakeWei),
          openedAt: trial.openedAt,
          txHash: trial.openTx,
        });
        continue;
      }
      settledCount += 1;
      distributedWei += trial.rewardWei;
      const bucket = settledByContestant.get(trial.contestant) ?? [];
      bucket.push(trial);
      settledByContestant.set(trial.contestant, bucket);
    }

    const entries: ChainHallEntry[] = [];
    for (const [account, trials] of settledByContestant) {
      const ordered = [...trials].sort((a, b) => b.score - a.score || a.settledAt - b.settledAt);
      const best = ordered[0]!;
      const identity = this.identities.get(account);
      const totalReward = trials.reduce((sum, trial) => sum + trial.rewardWei, 0n);
      entries.push({
        rank: 0,
        account,
        handle: identity?.handle ?? shortAddress(account),
        identityLinkedAt: identity?.linkedAt ?? 0,
        score: best.score,
        trialsSettled: trials.length,
        totalRewardEth: formatEther(totalReward),
        bestTrialId: best.trialId,
        settledAt: best.settledAt,
        proof: { trialId: best.trialId, txHash: best.settleTx, blockNumber: best.settleBlock },
      });
    }

    entries.sort((a, b) => b.score - a.score || a.settledAt - b.settledAt || a.account.localeCompare(b.account));
    entries.forEach((entry, index) => {
      entry.rank = index + 1;
    });
    openTrials.sort((a, b) => a.trialId - b.trialId);

    return {
      version: this.version,
      generatedAt: Date.now(),
      chainId: this.opts.chain.id,
      contract: this.opts.deployment?.address ?? null,
      status: this.status,
      lastSyncedBlock: this.lastSyncedBlock,
      error: this.lastError,
      stats: {
        identities: this.identities.size,
        trialsOpened: this.trials.size,
        trialsSettled: settledCount,
        distributedEth: formatEther(distributedWei),
      },
      entries,
      openTrials,
    };
  }
}

function lower(value: unknown): string {
  return String(value ?? "").toLowerCase();
}

function num(value: unknown): number {
  if (typeof value === "number") return value;
  if (typeof value === "bigint") return Number(value);
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function shortAddress(address: string): string {
  return address.length > 12 ? `${address.slice(0, 6)}…${address.slice(-4)}` : address;
}
