import { serve } from "@hono/node-server";
import { foundry } from "viem/chains";
import { createPublicClient, http, keccak256, toHex } from "viem";
import { Scribe, UNKNOWN_ALLOY, type AlloyState } from "@crucible/indexer";
import { ALLOY_ABI } from "@crucible/smith";
import { createApp } from "./app.js";
import { dlq } from "./dlq.js";
import { resolveSecurity } from "./security.js";

/**
 * API + indexer in one process.
 *
 * A separate Postgres-backed Ponder instance is the intended production shape; this
 * keeps the demo to a single command with no database to provision.
 */

function required(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`${name} is required`);
  return v;
}

const port = Number(process.env.PORT ?? 8787);
const rpcUrl = process.env.RPC_URL ?? "http://127.0.0.1:8545";
const trialsAddress = required("TRIALS_ADDRESS") as `0x${string}`;
const alloyAddress = required("ALLOY_ADDRESS") as `0x${string}`;

/**
 * How often the alloy sweep runs. A floor, not a guess at a block time: a malformed
 * value would make `setInterval` fire continuously, which is the self-inflicted RPC
 * hammering this cache exists to stop.
 */
const ALLOY_TTL_MS = (() => {
  const v = Number(process.env.ALLOY_TTL_MS ?? 2000);
  return Number.isFinite(v) && v > 0 ? v : 2000;
})();

const publicClient = createPublicClient({ chain: foundry, transport: http(rpcUrl) });

const scribe = new Scribe({
  trialsAddress,
  alloyAddress,
  chain: foundry,
  rpcUrl,
  fromBlock: process.env.FROM_BLOCK ? BigInt(process.env.FROM_BLOCK) : 0n,
  // Every failure the indexer survives lands in the dead-letter queue — a sync tick
  // that could not advance, a window it refused to cross — so /health tells an
  // operator the indexer is struggling without anyone reading this process's stdout.
  onError: (kind, detail) => dlq.push(`scribe.${kind}`, detail),
});

/**
 * The tier and the soulbound lock are `AlloyRegistry` state, so they are read from
 * `AlloyRegistry`. They used to be derived here from the read model — `locked` from
 * `agent.wins > 0 || agent.slashes > 0` — which is a guess dressed up as a chain fact,
 * and it said nothing at all about the tier.
 *
 * Cached per agentId behind a short TTL, swept by one background pass, rather than keyed
 * on the latest block number: block-keying needs a `getBlockNumber` call before every
 * snapshot just to learn whether anything moved, so a page polling `/snapshot` every
 * second drives the RPC itself, which is the denial-of-service against your own node this
 * cache exists to prevent. Here, request volume and read volume are decoupled: the sweep
 * runs on the tick whatever the load, and a miss returns `UNKNOWN_ALLOY` (nulls) instead
 * of a number nobody measured. The staleness bound is `ALLOY_TTL_MS`, which is fine for a
 * tier — a tier only moves when a trial settles, and settling is minutes apart.
 */
const alloyById = new Map<number, AlloyState>();

/**
 * Three view calls, all of which may fail independently. A failure is a null field, not
 * a zero: `tokenURI` reverts with `NotMinted` for an agent with no alloy, and an agent
 * the registry never touched is not the same as an agent whose tier is 0.
 */
async function readAlloy(agentId: number): Promise<AlloyState> {
  const args = [BigInt(agentId)] as const;
  // "NotMinted" is the registry saying *this agent has no alloy yet* — an answer, not a
  // failure, and the common state for a fresh agent. The selector check keeps that
  // answer quiet while every other revert (RPC down, pruned node, bad address) lands in
  // the dead-letter queue instead of vanishing into a null.
  const notMintedSelector = keccak256(toHex("NotMinted()")).slice(0, 10);
  const attempt = <T>(read: () => Promise<T>): Promise<T | null> =>
    read().catch((err) => {
      const text = err instanceof Error ? `${err.message} ${(err.cause as Error | undefined)?.message ?? ""}` : String(err);
      if (text.includes("NotMinted") || text.includes(notMintedSelector)) return null;
      dlq.push("alloy.read", `agent ${agentId}: ${text.slice(0, 200)}`);
      return null;
    });

  const [record, isLocked, tokenUri] = await Promise.all([
    attempt(() =>
      publicClient.readContract({
        address: alloyAddress,
        abi: ALLOY_ABI,
        functionName: "records",
        args,
      }),
    ),
    attempt(() =>
      publicClient.readContract({
        address: alloyAddress,
        abi: ALLOY_ABI,
        functionName: "locked",
        args,
      }),
    ),
    attempt(() =>
      publicClient.readContract({
        address: alloyAddress,
        abi: ALLOY_ABI,
        functionName: "tokenURI",
        args,
      }),
    ),
  ]);

  return {
    // `records(agentId)` is `(wins, survived, slashes, tier)`; only the tier is published,
    // because the counters on a hall row are the logs this process actually saw.
    tier: record === null ? null : record[3],
    locked: isLocked,
    tokenUri,
  };
}

/**
 * The agent ids can only come from the read model: `records` is a mapping, not a list, so
 * the registry itself cannot be enumerated. An agent the indexer has not seen yet is
 * therefore absent for one tick, and renders as unknown rather than as a guessed tier.
 */
async function sweepAlloy(): Promise<void> {
  const ids = [...scribe.state.agents.keys()];
  await Promise.all(
    ids.map(async (id) => {
      alloyById.set(id, await readAlloy(id));
    }),
  );
}

await scribe.sync();
scribe.hydrate();
void scribe.watch();

// Primed before the first request is served, so `/hall` never opens on an empty cache.
await sweepAlloy();
let sweeping = false;
setInterval(() => {
  // Overlap would double the reads against a slow RPC, which is exactly what a sweep
  // scheduled on a timer must not do.
  if (sweeping) return;
  sweeping = true;
  void sweepAlloy().finally(() => {
    sweeping = false;
  });
}, ALLOY_TTL_MS);

const trustProxy = process.env.TRUST_PROXY === "1";

/**
 * Resolved once, here, and handed to the app — so the policy printed at boot and the policy
 * serving requests cannot drift apart. A deployment that believes it set an allowlist can
 * read what it actually set.
 */
const security = resolveSecurity({ trustProxy }, process.env);

const app = createApp({
  getModel: () => scribe.state,
  // The hall's txHashes are only checkable against one chain and one contract, and the
  // read model cannot infer either — this process is the only party that knows them.
  proofSource: { chain: foundry.name, chainId: foundry.id, trialsAddress },
  alloyState: (agentId) => alloyById.get(agentId) ?? UNKNOWN_ALLOY,
  indexStatus: () => scribe.status,
}, {
  // Off by default: forwarded headers are caller-writable, so trusting them lets a loop
  // mint a new bucket per request. Set TRUST_PROXY=1 only behind something that overwrites
  // them (Cloudflare, an ALB) — which is what `cf-connecting-ip` is, and also what makes
  // `X-Forwarded-Proto` believable for the TLS check.
  trustProxy,
  security,
});

serve({ fetch: app.fetch, port }, (info) => {
  console.log(`[crucible] api listening on :${info.port}`);
  console.log(`[crucible] indexing ${trialsAddress}`);
  console.log(`[crucible] alloy from ${alloyAddress} every ${ALLOY_TTL_MS}ms`);
  // The transport policy, stated as what it is rather than as a checkbox. `*` here means
  // "reads are public by design, credentialed reads are impossible" — see security.ts.
  console.log(
    `[crucible] cors: ${
      security.allowedOrigins.includes("*")
        ? "any origin may read anonymously (no credentials)"
        : security.allowedOrigins.join(" ")
    }${security.allowCredentials ? " [credentials allowed]" : ""}`,
  );
  console.log(
    `[crucible] transport: ${
      security.enforceHttps
        ? `https required, HSTS max-age=${security.hstsMaxAge}s over TLS${trustProxy ? "" : " (TRUST_PROXY off: X-Forwarded-Proto will not be believed)"}`
        : "plaintext accepted (this is a local demo; set ENFORCE_HTTPS=1 behind a TLS proxy)"
    }`,
  );
  console.log(
    `[crucible] limits: body <= ${security.maxBodyBytes}B announced, request <= ${security.timeoutMs}ms (${
      security.timeoutExemptPaths.join(" ") || "no exemptions"
    } exempt)`,
  );
});
