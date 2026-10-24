import { serve } from "@hono/node-server";
import { foundry } from "viem/chains";
import { createPublicClient, http, keccak256, toHex } from "viem";
import { Scribe, UNKNOWN_ALLOY, type AlloyState } from "@crucible/indexer";
import { ALLOY_ABI, selfSchedulingLoop } from "@crucible/smith";
import { createApp } from "./app.js";
import { makeReplaySource } from "./replay.js";
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

/**
 * A required address, checked rather than cast.
 *
 * The old code cast whatever the environment held to an address type, so a
 * typo — `0x123` — passed the check and then failed at the first call, with
 * viem's error naming a method rather than the variable that was wrong. A
 * deployment that is misconfigured should say so at boot, in one sentence,
 * naming the variable.
 */
function requiredAddress(name: string): `0x${string}` {
  const value = required(name).trim();
  if (!/^0x[0-9a-fA-F]{40}$/.test(value)) {
    throw new Error(`${name} must be a 0x-prefixed 20-byte address; got "${value}"`);
  }
  return value as `0x${string}`;
}

/** A port, checked rather than trusted. `Number("nonsense")` is NaN. */
function requiredPort(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1 || value > 65_535) {
    throw new Error(`${name} must be a TCP port between 1 and 65535; got "${raw}"`);
  }
  return value;
}

/** A block number, checked rather than thrown at the first use. */
function optionalBlock(name: string): bigint {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return 0n;
  if (!/^\d+$/.test(raw.trim())) {
    throw new Error(`${name} must be a whole number of blocks; got "${raw}"`);
  }
  return BigInt(raw.trim());
}

/**
 * How often the indexer asks the node for new logs.
 *
 * This, not the stream, is the dominant term in how long a visitor waits to see a chain
 * event: the pump turns a moved read model into a frame within its own interval, but there
 * is nothing to deliver until the index has moved. The default is the indexer's own 2000ms
 * because a small number is free against a local Anvil and is a real recurring load on a
 * public RPC — so it is a deployment choice, not a code change. `compose.yaml` lowers it
 * for the demo, where the node is a container on the same network.
 *
 * The floor exists because `watch()` would otherwise spin on a zero or negative interval.
 */
function optionalPollMs(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 100 || value > 60_000) {
    throw new Error(`${name} must be a whole number of milliseconds between 100 and 60000; got "${raw}"`);
  }
  return value;
}

const port = requiredPort("PORT", 8787);
const scribePollMs = optionalPollMs("SCRIBE_POLL_MS", 2000);
const rpcUrl = process.env.RPC_URL ?? "http://127.0.0.1:8545";
const trialsAddress = requiredAddress("TRIALS_ADDRESS");
const alloyAddress = requiredAddress("ALLOY_ADDRESS");

/**
 * How often the alloy sweep runs. A floor, not a guess at a block time: a malformed
 * value would make `setInterval` fire continuously, which is the self-inflicted RPC
 * hammering this cache exists to stop.
 */
const ALLOY_TTL_MS = (() => {
  const v = Number(process.env.ALLOY_TTL_MS ?? 2000);
  return Number.isFinite(v) && v > 0 ? v : 2000;
})();

/**
 * How far back `/replay/:id` asks the node to look, in blocks. A floor and a default, not a
 * guess: `BigInt("abc")` throws at module load and takes the API down with it, so the value is
 * read as digits first and falls back rather than crashing a deployment over a typo.
 */
const replayWindowBlocks = (() => {
  const raw = (process.env.REPLAY_WINDOW_BLOCKS ?? "").trim();
  if (/^\d+$/.test(raw)) {
    const v = BigInt(raw);
    if (v > 0n) return v;
  }
  return 200_000n;
})();

/**
 * Frenchy is optional. Both the key and the voice id are configuration; a missing
 * either keeps the voice host off, and the web app hides the control. `VOICE_DISABLED=1`
 * is the kill switch for a deployment that has the credentials but wants silence.
 */
const voice = (() => {
  if (process.env.VOICE_DISABLED === "1") return null;
  const apiKey = process.env.ELEVENLABS_API_KEY?.trim();
  const voiceId = process.env.ELEVENLABS_VOICE_ID?.trim();
  const baseUrl = process.env.ELEVENLABS_BASE_URL?.trim() || undefined;
  const modelId = process.env.ELEVENLABS_MODEL_ID?.trim() || "eleven_flash_v2_5";
  if (!apiKey || !voiceId) return null;
  if (baseUrl && !/^https?:\/\//.test(baseUrl)) {
    throw new Error(`ELEVENLABS_BASE_URL must be an http(s) URL; got "${baseUrl}"`);
  }
  return { apiKey, voiceId, modelId, baseUrl };
})();

const publicClient = createPublicClient({ chain: foundry, transport: http(rpcUrl) });

const scribe = new Scribe({
  trialsAddress,
  alloyAddress,
  chain: foundry,
  rpcUrl,
  fromBlock: optionalBlock("FROM_BLOCK"),
  pollMs: scribePollMs,
  cursorFile: process.env.CRUSIBLE_CURSOR_FILE,
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
async function readAlloy(agentId: number): Promise<AlloyState | null> {
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

  const [tier, isLocked, tokenUri] = await Promise.all([
    attempt(() =>
      publicClient.readContract({
        address: alloyAddress,
        abi: ALLOY_ABI,
        functionName: "tierOf",
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

  // A failure is not a null tier — it is the absence of a tier, and the two
  // are different. The caller keeps the last good value so that one
  // transient RPC error does not turn a measured tier into "tier unknown"
  // for a whole TTL.
  if (tier === null && isLocked === null && tokenUri === null) return null;

  return {
    // `tierOf(agentId)` is read on its own rather than as the fourth
    // element of `records(...)`. A tuple is read by position, and the
    // position is a property of the contract's output ORDER: if that order
    // ever changed, `record[3]` would be a different field, and a number
    // that was never measured as a tier would be published as one. A
    // dedicated getter cannot drift that way.
    tier,
    locked: isLocked,
    tokenUri,
  };
}

// Declared before `sweepAlloy`, which runs at module init and reads it. As a `let` further down
// the file it sat in its temporal dead zone and the container crash-looped on every boot with
// "Cannot access protocolFeeBps before initialization".
let protocolFeeBps: number | null = null;

/** Concurrent registry reads per sweep. The size of the registry is not allowed to choose this. */
const ALLOY_SWEEP_BATCH = 8;

/**
 * The agent ids can only come from the read model: `records` is a mapping, not a list, so
 * the registry itself cannot be enumerated. An agent the indexer has not seen yet is
 * therefore absent for one tick, and renders as unknown rather than as a guessed tier.
 */
async function sweepAlloy(): Promise<void> {
  // A boot-time blip used to cost the rate for the life of the process: the read happened once,
  // its `catch` only logged, and every snapshot then published `feeBps: null`. `FEE_BPS` is a
  // public constant, so there is nothing to invalidate — retrying until it is read is free.
  if (protocolFeeBps === null) await readProtocolFee();

  const ids = [...scribe.state.agents.keys()];
  // Bounded fan-out. This used to be one unbounded `Promise.all`, at three `readContract` calls
  // per agent, every `ALLOY_TTL_MS` — and `registerAgent` costs only `MIN_BOND` and is never
  // removed, so anyone could add three permanent reads per two seconds to the node that the
  // indexer and `/snapshot` share. Eight at a time keeps a full sweep honest without letting the
  // registry's size choose this process's concurrency.
  for (let i = 0; i < ids.length; i += ALLOY_SWEEP_BATCH) {
    await Promise.all(
      ids.slice(i, i + ALLOY_SWEEP_BATCH).map(async (id) => {
        const state = await readAlloy(id);
        // A failed read does NOT overwrite what is known. The old code stored the
        // failure's nulls, so one transient RPC error turned a measured tier
        // into "tier unknown" for a whole TTL — and "the registry could not be
        // read" and "this agent has no alloy" became the same answer.
        if (state === null) return;
        alloyById.set(id, state);
      }),
    );
  }
}

// `sync()` is the breaker-guarded pass: a node that is down at boot is the outage the breaker
// exists for, and the tail below gets the same protection without a second code path.
await scribe.sync();
scribe.hydrate();
void scribe.watch();

// Primed before the first request is served, so `/hall` never opens on an empty cache.
await sweepAlloy();
// Scheduled off the previous pass rather than the wall clock: an overlapping sweep doubles the
// registry reads against a slow RPC, which is the one thing this cache exists to prevent.
selfSchedulingLoop(sweepAlloy, {
  intervalMs: ALLOY_TTL_MS,
  runImmediately: false,
  // A throw that is not an `Error` has no `.message`, and the dead-letter queue slices
  // whatever it is given — so `(err as Error).message` handed it `undefined` and the queue
  // threw while reporting the failure that had just been caught. The sweep's failure was
  // then swallowed by the loop and never reached the log either.
  onError: (err) => dlq.push("alloy.sweep", err instanceof Error ? err.message : String(err)),
}).start();

/**
 * The settlement fee, in basis points, read from the contract.
 *
 * It is a `constant`, so it cannot change, and it is read once: the host knows
 * the chain's own number rather than carrying a copy that could drift from it.
 *
 * **Null when the read fails, not zero.** The comment here used to say "a read
 * that fails leaves the books at zero rather than publishing a guess — a fee
 * nobody can verify is worse than an absent one", and the code did exactly the
 * opposite: it left the books at zero AND published it, as `feeBps: 0` and a
 * fee of "0" ETH, which reads as a measured fact. Zero is not an absent fee;
 * it is a claim that the protocol charges nothing.
 *
 * The money itself no longer depends on this read: the settlement logs carry
 * the payout the chain actually made, and the fee is the difference between
 * that and the escrowed reward. So the only thing lost by an unreadable
 * constant is the rate in basis points, and that is published as unknown.
 */
/**
 * Read `FEE_BPS` again. Called at boot and again from every alloy sweep while the value is null,
 * because a boot-time blip used to make the rate unknown for the life of the process — the value
 * is a public constant, so a retry can only succeed or stay honestly null.
 */
async function readProtocolFee(): Promise<void> {
  try {
    protocolFeeBps = Number(
      await publicClient.readContract({
        address: trialsAddress,
        abi: [{ type: "function", name: "FEE_BPS", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] }],
        functionName: "FEE_BPS",
      }),
    );
    console.log(`[crucible] protocol settlement fee: ${protocolFeeBps / 100}%`);
  } catch (err) {
    console.error(
      `[crucible] could not read FEE_BPS: ${err instanceof Error ? err.message : String(err)} — ` +
        "the rate is published as unknown; the settled amounts are read from the chain's own logs",
    );
  }
}
await readProtocolFee();

const trustProxy = process.env.TRUST_PROXY === "1";

/**
 * Resolved once, here, and handed to the app — so the policy printed at boot and the policy
 * serving requests cannot drift apart. A deployment that believes it set an allowlist can
 * read what it actually set.
 */
const security = resolveSecurity({ trustProxy }, process.env);

/**
 * The transport flags have to move together, and nothing enforced that.
 *
 * `ENFORCE_HTTPS=1` makes the API refuse any request it cannot see as TLS.
 * Behind a proxy that terminates TLS, the request arrives in plaintext and
 * the scheme is only in `X-Forwarded-Proto` — which is believed only when
 * `TRUST_PROXY=1`. So `ENFORCE_HTTPS=1` with `TRUST_PROXY=0` answers 403 to
 * EVERY request, and the boot log mentions it in a parenthetical nobody
 * reads. A deployment that refuses to start is better than one that starts
 * and serves nothing.
 */
if (security.enforceHttps && !trustProxy) {
  throw new Error(
    "ENFORCE_HTTPS=1 with TRUST_PROXY=0 would answer 403 to every request: " +
      "the proxy's X-Forwarded-Proto is not believed without TRUST_PROXY=1. " +
      "Set TRUST_PROXY=1 (only behind a proxy that overwrites it), or turn ENFORCE_HTTPS off.",
  );
}

/**
 * Credentials over plaintext are not a policy anybody wants.
 *
 * `ALLOW_CREDENTIALS=1` with an `http://` origin means the browser is told
 * to send cookies to that origin with every request. The wildcard case is
 * already refused, and the boot log states the policy — but a configuration
 * that hands a credentialed CORS policy to a plaintext origin is a mistake
 * that should be refused rather than reported.
 */
if (security.allowCredentials) {
  for (const origin of security.allowedOrigins) {
    if (origin === "*") continue;
    if (!origin.startsWith("https://") && !/^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin)) {
      throw new Error(
        `ALLOW_CREDENTIALS=1 with a plaintext origin (${origin}) would tell a browser to send ` +
          "credentials over http. Use https, or a local address.",
      );
    }
  }
}

const app = createApp({
  getModel: () => scribe.state,
  // The hall's txHashes are only checkable against one chain and one contract, and the
  // read model cannot infer either — this process is the only party that knows them.
  proofSource: { chain: foundry.name, chainId: foundry.id, trialsAddress },
  alloyState: (agentId) => alloyById.get(agentId) ?? UNKNOWN_ALLOY,
  // The chain's own fee constant, so the published books are the ones the
  // contract charges rather than ones this process keeps a copy of.
  protocolFeeBps: () => protocolFeeBps,
  indexStatus: () => scribe.status,
  // The one breaker this process runs: the node the index is read from. Reporting it is what
  // turns "the hall stopped moving" into "the node is tripped, with 12s of cooldown left".
  breakers: () => ({ [scribe.breaker.name]: scribe.breaker.status() }),
}, {
  // The replay projector reads a trial's own logs back from the node the index already talks
  // to. Same hop, same breaker, no new authority: the API still holds no chain key (ADR-0006).
  replay: makeReplaySource({ reader: publicClient, address: trialsAddress, windowBlocks: replayWindowBlocks }),
  // Off by default: forwarded headers are caller-writable, so trusting them lets a loop
  // mint a new bucket per request. Set TRUST_PROXY=1 only behind something that overwrites
  // them (Cloudflare, an ALB) — which is what `cf-connecting-ip` is, and also what makes
  // `X-Forwarded-Proto` believable for the TLS check.
  trustProxy,
  security,
  voice,
});

serve({ fetch: app.fetch, port }, (info) => {
  console.log(`[crucible] api listening on :${info.port}`);
  console.log(`[crucible] indexing ${trialsAddress}`);
  // The poll period is the biggest single term in how long a visitor waits to see a chain
  // event, and it is now configurable. A number that decides perceived speed and appears
  // nowhere in the log is a number an operator has to guess at while debugging exactly that.
  console.log(`[crucible] polling the node every ${scribePollMs}ms`);
  console.log(`[crucible] alloy from ${alloyAddress} every ${ALLOY_TTL_MS}ms`);
  console.log(
    voice
      ? `[crucible] voice: Frenchy on (${voice.modelId})`
      : "[crucible] voice: off (set ELEVENLABS_API_KEY and ELEVENLABS_VOICE_ID to enable)",
  );
  // A replay reads the trial's own logs back from the node, so the window it searches is a
  // fact an operator needs when a replay comes back missing its first beats.
  console.log(`[crucible] replay: last ${replayWindowBlocks} blocks per trial`);
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
  // Which address the limiter buckets by. This is the whole control, so it is stated
  // rather than left to be discovered: behind a proxy with TRUST_PROXY off, every visitor
  // shares ONE bucket because the only address this process can see is the proxy's, and
  // one refresh loop starves everyone else.
  console.log(
    `[crucible] rate limit key: ${
      trustProxy
        ? "the right-most X-Forwarded-For entry (the address the proxy recorded)"
        : "the socket peer (every visitor behind a proxy shares one bucket)"
    }`,
  );
  console.log(
    `[crucible] limits: body <= ${security.maxBodyBytes}B announced, request <= ${security.timeoutMs}ms (${
      security.timeoutExemptPaths.join(" ") || "no exemptions"
    } exempt)`,
  );
});
