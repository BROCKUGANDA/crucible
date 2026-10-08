import { createServer } from "node:http";
import { createWalletClient, http } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { foundry } from "viem/chains";
import { Scribe } from "@crucible/indexer";
import { CircuitBreaker, Crucible, Flags } from "@crucible/smith";
import { Warden } from "@crucible/warden";
import { createSweepLoop, envKillSwitches } from "./sweep-loop.js";

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
 * The key it signs with is a bystander: finalize moves no caller funds. The default
 * is Anvil's published development key — right for the demo, wrong for anything real,
 * which is what PRIVATE_KEY is for.
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

/** Anvil's published dev key #0 — the demo relayer, same default as Deploy.s.sol. */
const DEMO_RELAYER_KEY =
  "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";

const port = Number(process.env.PORT ?? 8789);
const rpcUrl = process.env.RPC_URL ?? "http://127.0.0.1:8545";
const trialsAddress = required("TRIALS_ADDRESS") as `0x${string}`;
const alloyAddress = required("ALLOY_ADDRESS") as `0x${string}`;
const sweepMs = Number(process.env.SWEEP_MS ?? 15_000);

// `||` not `??`: compose always sets PRIVATE_KEY, but may set it to the empty
// string when no KEEPER_PRIVATE_KEY is configured — empty must fall through too.
const account = privateKeyToAccount(
  (process.env.PRIVATE_KEY || DEMO_RELAYER_KEY) as `0x${string}`,
);

const scribe = new Scribe({
  trialsAddress,
  alloyAddress,
  chain: foundry,
  rpcUrl,
  fromBlock: process.env.FROM_BLOCK ? BigInt(process.env.FROM_BLOCK) : 0n,
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

const warden = new Warden({ crucible, wallet, onLog: (line) => console.log(`[warden] ${line}`) });

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

const sweepLoop = createSweepLoop({
  intervalMs: sweepMs,
  breaker: sweepBreaker,
  flags,
  // The decision clock is the CHAIN's clock, not this host's: the demo chain is warpable
  // (that is the whole point of a demo), and a keeper that compared window deadlines against
  // wall-clock time would sit on its hands for the two hours a test warp put between them.
  chainNow: async () => Number((await crucible.publicClient.getBlock()).timestamp),
  act: (nowSeconds) => warden.sweep(scribe.state, nowSeconds),
  onLog: (line) => console.log(`[keeper] ${line}`),
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
    res.end(
      JSON.stringify({
        ok: fresh,
        keeper: account.address,
        trials: scribe.state.trials.size,
        indexedTo: index.indexedTo === null ? null : Number(index.indexedTo),
        lastSweepAt: status.lastSweepAt,
        lastSweepActed: status.lastSweepActed,
        // The difference between "nothing needed doing" and "we were told not to do anything".
        killed: status.killed,
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
