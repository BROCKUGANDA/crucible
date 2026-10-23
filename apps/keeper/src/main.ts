import { createServer } from "node:http";
import { resolve as resolvePath } from "node:path";
import { fileURLToPath } from "node:url";
import { createPublicClient, createWalletClient, http } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { foundry } from "viem/chains";
import { Scribe } from "@crucible/indexer";
import { CircuitBreaker, Crucible, Flags } from "@crucible/smith";
import { TraceLog, type TraceSpan } from "@crucible/smith/trace";
import { Warden } from "@crucible/warden";
import { createSweepLoop, envKillSwitches } from "./sweep-loop.js";
import { createGasLedger, parseBalanceFloor } from "./gas-ledger.js";

/**
 * The Warden as a service.
 *
 * Trials whose skeptic window closed with no break do not settle themselves — the
 * contract's `finalize` is permissionless, which means somebody still has to send it.
 * The UI and the golden-path script both can; this keeper is the part that means no
 * one has to. It runs its own indexer against the chain and sweeps on an interval:
 * every action is idempotent by construction (finalize and reclaimExpired revert if
 * someone else got there first), so a retried tick is harmless rather than
 * double-paying.
 *
 * `KILL_SWITCHES` — comma-separated flag names, `keeper.sweep` being the one this
 * process obeys. Set it (in compose, or whatever writes the environment) and the keeper
 * stops sending transactions on the next flag poll without a deploy; clear it and it
 * resumes. `/health` then reports `killed: true` with the sweep breaker beside it, so a
 * held keeper never reads as a healthy one.
 */

function required(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`${name} is required`);
  return v;
}

/**
 * Anvil's published dev key #0 — the demo relayer, same default as Deploy.s.sol. It is
 * public in Anvil's own documentation, so every account derived from it is public too.
 * That is fine against a worthless local chain and a liability against any funded one,
 * which is exactly why nothing below may reach it without proving the chain first.
 */
const DEMO_RELAYER_KEY = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";

/** Anvil's default chain id — the number `anvil` reports before anything warps it. */
const ANVIL_CHAIN_ID = 31337;

/**
 * The only hostnames this keeper will fall back to a public key against. A loopback
 * address is reachable only from the machine the keeper already runs on, so a chain on
 * one of these cannot be the public internet's view of a funded network. A Docker service
 * name (`anvil`) is deliberately NOT here: inside the compose network that host is
 * reachable from other containers, and the deployed VPS keeper runs on a host the browser
 * reaches, so treating it as "provably local" is the exact hole this closes.
 */
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "::1"]);

/** The two modes the boot log names, and the only two outcomes of the decision below. */
const DEV_MODE = "dev relayer on local Anvil";
const CONFIGURED_MODE = "configured keeper key";

type KeeperAccount = ReturnType<typeof privateKeyToAccount>;

export interface ResolvedKeeperAccount {
  account: KeeperAccount;
  /** "dev relayer on local Anvil" or "configured keeper key" — for the boot log. */
  mode: string;
}

/**
 * Decide which account the keeper signs with, WITHOUT ever silently using the public key.
 *
 * This is the single rule the audit asked for — there is no strict-mode flag, no second
 * path, nothing that lets a funded chain quietly inherit Anvil's key #0:
 *
 *   1. A non-empty PRIVATE_KEY is an explicit operator decision. Use it. We do not
 *      second-guess which chain it is meant for.
 *   2. An empty/unset PRIVATE_KEY may fall back to the published dev key ONLY on a chain
 *      that is provably the local Anvil demo. "Provably" is the load-bearing word: the
 *      host must be loopback AND the node itself must answer `eth_chainId` with 31337.
 *      The chain id is read from the node, not from a config value someone could set to
 *      whatever passes a check — that distinction is the whole point.
 *   3. Every other combination throws. Loudly, and naming the variable to set.
 *
 * Empty string is treated as unset because that is what compose hands us: `compose.yaml`
 * sets `PRIVATE_KEY: ${KEEPER_PRIVATE_KEY:-}`, so a missing KEEPER_PRIVATE_KEY arrives as
 * "". This is the `||`-not-`??` nuance from the original code, now expressed against the
 * new rule — a blank must fall through to the *check*, and the check must then fall
 * through to the *throw*, never to a bare default key.
 *
 * `main.ts`'s own boot path and the keeper's test call this same function, so the branch
 * the demo relies on and the branch an operator is protected by are the one branch that
 * actually runs in production.
 */
export async function resolveKeeperAccount(opts: {
  privateKey: string | undefined;
  rpcUrl: string;
}): Promise<ResolvedKeeperAccount> {
  const key = opts.privateKey?.trim() ?? "";

  // Rule 1: a key was configured — honour it, no chain interrogation.
  if (key) {
    return { account: privateKeyToAccount(key as `0x${string}`), mode: CONFIGURED_MODE };
  }

  // Rule 3 is checked before rule 2's expensive half: if the host is not loopback this is
  // not the local demo and we refuse, without ever opening a client to an arbitrary host.
  const host = new URL(opts.rpcUrl).hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (!LOOPBACK_HOSTS.has(host)) {
    throw new Error(
      `keeper refusing to start: PRIVATE_KEY is empty, and the published Anvil dev key is only ` +
        `safe on the local Anvil demo — the RPC host "${opts.rpcUrl}" is not a loopback address. ` +
        `Set PRIVATE_KEY (KEEPER_PRIVATE_KEY in compose) to the key this keeper must sign with.`,
    );
  }

  // The host is loopback; now prove the node behind it is really Anvil. A client that
  // cannot be reached is refused, not assumed — fail closed, never open.
  let chainId: number;
  try {
    chainId = await createPublicClient({ transport: http(opts.rpcUrl) }).getChainId();
  } catch (err) {
    throw new Error(
      `keeper refusing to start: PRIVATE_KEY is empty, and the loopback RPC ${opts.rpcUrl} did ` +
        `not answer eth_chainId (${(err as Error).message}), so its chain cannot be proven to be ` +
        `the local Anvil demo. Set PRIVATE_KEY (KEEPER_PRIVATE_KEY in compose) to the key this ` +
        `keeper must sign with.`,
    );
  }
  if (chainId !== ANVIL_CHAIN_ID) {
    throw new Error(
      `keeper refusing to start: PRIVATE_KEY is empty and the loopback RPC ${opts.rpcUrl} reports ` +
        `chainId ${chainId}, not the local Anvil demo's ${ANVIL_CHAIN_ID}. Set PRIVATE_KEY ` +
        `(KEEPER_PRIVATE_KEY in compose) to the key this keeper must sign with.`,
    );
  }

  // Rule 2 satisfied: loopback host, Anvil chain. The published key is public against a
  // worthless local chain, so it is the right choice here — and only here.
  return { account: privateKeyToAccount(DEMO_RELAYER_KEY as `0x${string}`), mode: DEV_MODE };
}

/**
 * Boot the keeper. Everything that touches a chain, a socket, or the process timer lives
 * here, so importing this module (as the test does) runs no side effects: no env is
 * demanded, no node is dialed, nothing listens. The module only *is* the service when it
 * is the process's entry point.
 */
async function boot(): Promise<void> {
  const port = Number(process.env.PORT ?? 8789);
  const rpcUrl = process.env.RPC_URL ?? "http://127.0.0.1:8545";
  const trialsAddress = required("TRIALS_ADDRESS") as `0x${string}`;
  const alloyAddress = required("ALLOY_ADDRESS") as `0x${string}`;
  const sweepMs = Number(process.env.SWEEP_MS ?? 15_000);
  /**
   * The floor at which the operator wants to hear about the wallet. Unset means no alarm rather
   * than a threshold invented in code — the balance is still published either way.
   */
  const minBalanceWei = parseBalanceFloor(process.env.KEEPER_MIN_BALANCE_WEI);

  const { account, mode } = await resolveKeeperAccount({
    privateKey: process.env.PRIVATE_KEY,
    rpcUrl,
  });

  // Address and mode only. The private key never reaches a log line, an exception, or the
  // health payload — this is the same address the `/health` handler already reports.
  console.log(`[keeper] ${mode} — signer ${account.address}`);

  const scribe = new Scribe({
    trialsAddress,
    alloyAddress,
    chain: foundry,
    rpcUrl,
    fromBlock: process.env.FROM_BLOCK ? BigInt(process.env.FROM_BLOCK) : 0n,
    cursorFile: process.env.CRUSIBLE_CURSOR_FILE,
    onError: (kind, detail) => console.error(`[scribe] ${kind}: ${detail}`),
  });

  const crucible = new Crucible({
    trialsAddress,
    alloyAddress,
    chain: foundry,
    rpcUrl,
  });

  const wallet = createWalletClient({
    account,
    chain: foundry,
    transport: http(rpcUrl),
  });

  /**
   * What this account is paying to run the demo. Gas is the network's toll, not the forge's fee:
   * nothing here touches `FEE_BPS` or the escrow's conservation invariant, which counts only ETH
   * the contract holds. It exists because the keeper fired a transaction, kept the hash, and never
   * read the receipt back — so the operating cost was unmeasured and a drained wallet arrived as a
   * silent stall rather than a number on `/health`.
   */
  const gas = createGasLedger({
    reader: crucible.publicClient,
    signer: account.address,
    minBalance: minBalanceWei,
    log: (line) => console.log(`[keeper] ${line}`),
  });

  const warden = new Warden({
    crucible,
    wallet,
    // The chain's clock, not this host's. `start()` now requires the seam because a demo chain is
    // warped on purpose, and a sweep comparing window deadlines against wall time sits idle for the
    // length of the warp while `/health` reports that everything is fine.
    now: async () => Number((await crucible.publicClient.getBlock()).timestamp),
    onLog: (line) => console.log(`[warden] ${line}`),
  });

  /**
   * Two guards on the one hop, in the order that matters: the switch first, so an operator's
   * halt is never mistaken for an outage, then the breaker, so a node that stops answering gets
   * refused rather than retried until the process is a queue of dead calls. Three failed passes
   * trip it; it spends 30s before probing again. Named for the dependency it guards, because
   * that is what the refusal copy and `/health` have to say.
   */
  const sweepBreaker = new CircuitBreaker({
    name: "keeper.rpc",
    threshold: 3,
    windowMs: 60_000,
    cooldownMs: 30_000,
  });

  const flags = new Flags({
    source: envKillSwitches(),
    onError: (err) => console.error(`[keeper] flag source failed: ${(err as Error).message}`),
  });

  /**
   * The trace spine, when a file is configured.
   *
   * Off by default: a process that has not been asked to keep a record should not create
   * files. `compose.yaml` sets the path for the demo so the chain has a real producer from
   * the first sweep — the spans here are actions that actually happened (a finalize, a
   * reclaim, a skip), not the gate-by-gate verification the showcase blueprint imagined,
   * which would have had nothing behind it because no service runs those gates yet.
   *
   * Every append is guarded. A trace that cannot be written is a missing record, not a
   * reason to stop settling trials — the chain is the source of truth and this is a
   * projection of it, in that order.
   */
  const traceFile = process.env.CRUCIBLE_TRACE_FILE?.trim();
  const trace = traceFile ? await TraceLog.open(traceFile) : null;
  if (trace && traceFile) {
    console.log(`[keeper] tracing to ${traceFile} (head ${trace.head.slice(0, 12)}…)`);
  }

  async function record(span: TraceSpan): Promise<void> {
    if (!trace) return;
    try {
      await trace.append(span);
    } catch (err) {
      console.error(`[keeper] trace append failed: ${(err as Error).message}`);
    }
  }

  const sweepLoop = createSweepLoop({
    intervalMs: sweepMs,
    breaker: sweepBreaker,
    flags,
    // The decision clock is the CHAIN's clock, not this host's: the demo chain is warpable
    // (that is the whole point of a demo), and a keeper that compared window deadlines against
    // wall-clock time would sit on its hands for the two hours a test warp put between them.
    chainNow: async () => Number((await crucible.publicClient.getBlock()).timestamp),
    act: async (nowSeconds) => {
      const result = await warden.sweep(scribe.state, nowSeconds);
      // Only a sweep that did something is recorded. A span every fifteen seconds saying
      // "nothing happened" is not evidence, it is noise: it would bury the one sweep that
      // mattered and grow the file by thousands of lines a day on an idle demo. The trace is
      // for actions, and an empty sweep is the absence of one.
      if (result.acted.length > 0) {
        await record({
          ts: Date.now(),
          span: "keeper.sweep",
          actor: "keeper",
          detail: {
            chainNow: result.now,
            acted: result.acted.length,
            notified: result.notified,
          },
        });
      }
      for (const a of result.acted) {
        await record({
          ts: Date.now(),
          span: "keeper.act",
          actor: "keeper",
          trialId: Number(a.decision.trialId),
          // `txHash` is null when the action was skipped, and `error` carries why. Both are
          // worth recording: a skip is how the keeper shows that someone else got there
          // first, and a run of them is the shape of an indexer ahead of the chain.
          detail: a.error
            ? { action: a.decision.action, reason: a.decision.reason, error: a.error }
            : {
                action: a.decision.action,
                reason: a.decision.reason,
                txHash: a.txHash ?? null,
              },
        });
      }
      // Accounting follows the sweep it describes, on the same cadence, and never in front of it.
      // `observe` returns immediately and a receipt that will not arrive lands in `unresolvedTxes`,
      // so an unreadable cost cannot stall a settlement — that is the property that keeps this
      // separate from the await chain above.
      for (const a of result.acted) if (a.txHash) gas.observe(a.txHash as `0x${string}`);
      void gas.refreshBalance();
      return result;
    },
    onLog: (line) => console.log(`[keeper] ${line}`),
  });

  // Provenance for the trace's own first entry: which build, which signer, which contract.
  // Public values only — the same ones /health already reports.
  await record({
    ts: Date.now(),
    span: "keeper.start",
    actor: "keeper",
    detail: { mode, signer: account.address, trials: trialsAddress },
  });

  await scribe.sync();
  scribe.hydrate();
  void scribe.watch();
  await sweepLoop.sweep();
  sweepLoop.handle.start();

  /** A health endpoint the compose probe can poll: liveness plus sweep freshness. */
  createServer((req, res) => {
    if (req.url === "/health") {
      const index = scribe.status;
      const status = sweepLoop.status();
      const fresh = status.lastSweepAt !== null && Date.now() - status.lastSweepAt < sweepMs * 4;
      res.writeHead(fresh ? 200 : 503, { "content-type": "application/json" });
      const ledger = gas.snapshot();
      res.end(
        JSON.stringify({
          ok: fresh,
          keeper: account.address,
          mode,
          trials: scribe.state.trials.size,
          indexedTo: index.indexedTo === null ? null : Number(index.indexedTo),
          lastSweepAt: status.lastSweepAt,
          lastSweepActed: status.lastSweepActed,
          // The difference between "nothing needed doing" and "we were told not to do anything".
          killed: status.killed,
          // Wei as decimal strings: a BigInt in a JSON body throws, and a Number would round the
          // very figure this exists to state exactly. `null` means unread, never zero.
          gas: {
            txesAccounted: Number(ledger.settledTxes),
            weiSpent: ledger.weiSpent.toString(),
            txesUnresolved: Number(ledger.unresolvedTxes),
            balanceWei: ledger.balanceWei === null ? null : ledger.balanceWei.toString(),
            minBalanceWei: ledger.minBalanceWei === null ? null : ledger.minBalanceWei.toString(),
            lowBalance: ledger.lowBalance,
          },
          breakers: {
            [sweepBreaker.name]: status.breaker,
            [scribe.breaker.name]: scribe.breaker.status(),
          },
        }),
      );
      return;
    }
    res.writeHead(404).end();
  }).listen(port, () => console.log(`[keeper] health on :${port} — signer ${account.address}`));

  function shutdown(): void {
    // `stop()` on the handle, not `clearInterval` on a timer: what an operator is asking for is
    // that no further pass starts, which a cleared timer only promises for the next one.
    sweepLoop.handle.stop();
    void flags.stop();
    scribe.stop();
    process.exit(0);
  }
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

/**
 * Run the service only when this file is the process's entry point — `node dist/main.js`
 * in the container, `tsx src/main.ts` under `npm run dev`. When the module is imported
 * (the keeper test imports it to reach `resolveKeeperAccount`) none of `boot()` fires, so
 * no chain is dialled, no env is demanded and no socket opens.
 *
 * Comparing resolved absolute paths rather than string-equality: argv[1] may arrive
 * relative to the working directory, and Node's `fileURLToPath` and the shell's path do
 * not agree on separators or drive-letter case on Windows.
 */
const entry = process.argv[1];
if (entry && resolvePath(entry) === resolvePath(fileURLToPath(import.meta.url))) {
  await boot();
}
