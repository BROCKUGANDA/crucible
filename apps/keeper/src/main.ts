import { createServer } from "node:http";
import { createWalletClient, http } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { foundry } from "viem/chains";
import { Scribe } from "@crucible/indexer";
import { Crucible } from "@crucible/smith";
import { Warden } from "@crucible/warden";

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

const account = privateKeyToAccount(
  (process.env.PRIVATE_KEY ?? DEMO_RELAYER_KEY) as `0x${string}`,
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

let lastSweepAt: number | null = null;
let lastSweepActed = 0;
let sweeping = false;

async function sweep(): Promise<void> {
  if (sweeping) return;
  sweeping = true;
  try {
    const result = await warden.sweep(scribe.state, Math.floor(Date.now() / 1000));
    lastSweepAt = Date.now();
    lastSweepActed = result.acted.length;
    if (result.acted.length > 0) console.log(`[keeper] acted on ${result.acted.length} trial(s)`);
  } catch (err) {
    console.error(`[keeper] sweep failed: ${(err as Error).message}`);
  } finally {
    sweeping = false;
  }
}

await scribe.sync();
scribe.hydrate();
void scribe.watch();
await sweep();
const sweepTimer = setInterval(() => void sweep(), sweepMs);

/** A health endpoint the compose probe can poll: liveness plus sweep freshness. */
createServer((req, res) => {
  if (req.url === "/health") {
    const index = scribe.status;
    const fresh = lastSweepAt !== null && Date.now() - lastSweepAt < sweepMs * 4;
    res.writeHead(fresh ? 200 : 503, { "content-type": "application/json" });
    res.end(
      JSON.stringify({
        ok: fresh,
        keeper: account.address,
        trials: scribe.state.trials.size,
        indexedTo: index.indexedTo === null ? null : Number(index.indexedTo),
        lastSweepAt,
        lastSweepActed,
      }),
    );
    return;
  }
  res.writeHead(404).end();
}).listen(port, () => console.log(`[keeper] health on :${port} — signer ${account.address}`));

function shutdown(): void {
  clearInterval(sweepTimer);
  scribe.stop();
  process.exit(0);
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
