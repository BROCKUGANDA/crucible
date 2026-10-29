import { serve } from "@hono/node-server";
import { foundry } from "viem/chains";
import { createPublicClient, http, keccak256, toHex, type Address } from "viem";
import {
  ARENA_EVENT_NAMES,
  TEAM_LEDGER_EVENTS,
  TEAM_LEDGER_SOURCE,
  emptyArenaModel,
  emptyTeamLedgerModel,
  replayArena,
  replayTeamLedger,
  Scribe,
  TRIALS_SOURCE,
  UNKNOWN_ALLOY,
  type AlloyState,
  type ArenaModel,
  type TeamLedgerModel,
} from "@crucible/indexer";
import { ALLOY_ABI, ARENA_ABI, TEAM_LEDGER_ABI, selfSchedulingLoop } from "@crucible/smith";
import { webhookNotifier } from "@crucible/warden";
import { createApp } from "./app.js";
import { OwnerGate, SponsorshipQueue, sponsorshipMessage } from "./sponsorship.js";
import { disclosureFileIn, disclosedCids as readDisclosure, type DisclosureEntry } from "./disclosure.js";
import { createContentSource, digestToCidMap } from "./content.js";
import { makeReplaySource } from "./replay.js";
import { dlq } from "./dlq.js";
import { createPassportSource } from "./passport.js";
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

/** A positive integer from the environment, or the default; a malformed value stops the boot. */
function positiveInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1) {
    throw new Error(`${name} must be a positive integer, got ${JSON.stringify(raw)}`);
  }
  return value;
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
const teamLedgerAddress = (process.env.TEAM_LEDGER_ADDRESS ?? "").trim();
const funderUrl = (process.env.FUNDER_URL ?? "").trim();

/**
 * The wallets allowed to read the sponsorship queue.
 *
 * Comma-separated, because one operator is the common case and a team is the
 * next one, and a list is barely harder than a single value. Empty means this
 * host keeps no queue behind an owner: applications are still recorded and the
 * owner is still notified, but nobody can read the queue back over HTTP.
 */
const ownerAddresses = (process.env.CRUCIBLE_OWNER_ADDRESSES ?? "")
  .split(",")
  .map((a) => a.trim())
  .filter((a) => a.length > 0);

/**
 * The push channel for sponsorship applications.
 *
 * The same webhook the warden's trial pings use (`WARDEN_WEBHOOK_URL`), because
 * there is one channel and one URL in this deployment, and a second notifier
 * beside the first is how a host ends up with two places a notice can be
 * delivered and neither of them is the one that was configured.
 *
 * The URL is never printed - a webhook URL may carry a secret token - and the
 * fetch is given a deadline so a hanging channel costs the applicant a moment
 * rather than the request.
 */
const webhookUrl = (process.env.WARDEN_WEBHOOK_URL ?? "").trim();
const sponsorshipNotifier = webhookUrl
  ? webhookNotifier<{ message: string }>(webhookUrl, (input, init) =>
      fetch(input, { ...init, signal: AbortSignal.timeout(2000) }),
    )
  : null;

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
  const modelId = process.env.ELEVENLABS_MODEL_ID?.trim() || "eleven_multilingual_v4";
  if (!apiKey || !voiceId) return null;
  if (baseUrl && !/^https?:\/\//.test(baseUrl)) {
    throw new Error(`ELEVENLABS_BASE_URL must be an http(s) URL; got "${baseUrl}"`);
  }
  return { apiKey, voiceId, modelId, baseUrl };
})();

/**
 * Frenchy's brain — the conversational assistant. Optional, off by default.
 * Requires an LLM provider (OpenAI-compatible). Premium TTS uses ElevenLabs if configured.
 */
const frenchy = (() => {
  if (process.env.FRENCHY_DISABLED === "1") return null;
  const llmApiKey = process.env.FRENCHY_LLM_API_KEY?.trim();
  const llmModel = process.env.FRENCHY_LLM_MODEL?.trim() || "gpt-4o-mini";
  const llmBaseUrl = process.env.FRENCHY_LLM_BASE_URL?.trim() || undefined;
  if (!llmApiKey) return null;
  if (llmBaseUrl && !/^https?:\/\//.test(llmBaseUrl)) {
    throw new Error(`FRENCHY_LLM_BASE_URL must be an http(s) URL; got "${llmBaseUrl}"`);
  }

  // Optional premium TTS
  let tts: { apiKey: string; voiceId: string; modelId?: string; baseUrl?: string } | undefined;
  if (process.env.FRENCHY_TTS_DISABLED !== "1") {
    const ttsApiKey = process.env.ELEVENLABS_API_KEY?.trim();
    const ttsVoiceId = process.env.ELEVENLABS_VOICE_ID?.trim();
    const ttsBaseUrl = process.env.ELEVENLABS_BASE_URL?.trim() || undefined;
    const ttsModelId = process.env.ELEVENLABS_MODEL_ID?.trim() || "eleven_multilingual_v4";
    if (ttsApiKey && ttsVoiceId) {
      if (ttsBaseUrl && !/^https?:\/\//.test(ttsBaseUrl)) {
        throw new Error(`ELEVENLABS_BASE_URL must be an http(s) URL; got "${ttsBaseUrl}"`);
      }
      tts = { apiKey: ttsApiKey, voiceId: ttsVoiceId, modelId: ttsModelId, baseUrl: ttsBaseUrl };
    }
  }

  // Optional ElevenLabs Scribe Realtime STT
  let scribe: { apiKey: string; modelId?: string; baseUrl?: string } | undefined;
  if (process.env.FRENCHY_SCRIBE_DISABLED !== "1") {
    const scribeApiKey = process.env.ELEVENLABS_API_KEY?.trim();
    const scribeBaseUrl = process.env.ELEVENLABS_BASE_URL?.trim() || undefined;
    const scribeModelId = process.env.ELEVENLABS_SCRIBE_MODEL_ID?.trim() || "scribe_v2_realtime";
    if (scribeApiKey) {
      if (scribeBaseUrl && !/^https?:\/\//.test(scribeBaseUrl)) {
        throw new Error(`ELEVENLABS_BASE_URL must be an http(s) URL; got "${scribeBaseUrl}"`);
      }
      scribe = { apiKey: scribeApiKey, modelId: scribeModelId, baseUrl: scribeBaseUrl };
    }
  }

  return { llm: { apiKey: llmApiKey, model: llmModel, baseUrl: llmBaseUrl }, tts, scribe };
})();

const publicClient = createPublicClient({ chain: foundry, transport: http(rpcUrl) });

const scribe = new Scribe({
  source: { ...TRIALS_SOURCE, address: trialsAddress },
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
 * Five view calls per agent, all of which may fail independently. A failure is a null field, not
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

  const [tier, isLocked, tokenUri, epochRow, holderRow] = await Promise.all([
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
    // ADR-0012, and read as its own named getter rather than as slice of `records`: this file's own
    // comment below explains why a number picked out of a nine-wide tuple by position is a number
    // that can be published without ever having been measured. `epochOf` never reverts for an
    // unminted agent — it answers zeros, which is a real reading (no outcome recorded), as distinct
    // from the null this returns when the RPC itself failed.
    attempt(() =>
      publicClient.readContract({
        address: alloyAddress,
        abi: ALLOY_ABI,
        functionName: "epochOf",
        args,
      }),
    ),
    attempt(() =>
      publicClient.readContract({
        address: alloyAddress,
        abi: ALLOY_ABI,
        functionName: "holderOf",
        args,
      }),
    ),
  ]);

  // A failure is not a null tier — it is the absence of a tier, and the two
  // are different. The caller keeps the last good value so that one
  // transient RPC error does not turn a measured tier into "tier unknown"
  // for a whole TTL.
  const [epoch, epochStartedAt, lifetimeWins, lifetimeSlashes] = epochRow ?? [];
  if (tier === null && isLocked === null && tokenUri === null && epochRow === null) return null;

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
    epoch: epoch === undefined ? null : Number(epoch),
    epochStartedAt: epochStartedAt === undefined ? null : Number(epochStartedAt),
    lifetimeWins: lifetimeWins === undefined ? null : Number(lifetimeWins),
    lifetimeSlashes: lifetimeSlashes === undefined ? null : Number(lifetimeSlashes),
    holder: holderRow ?? null,
  };
}

// Declared before `sweepAlloy`, which runs at module init and reads it. As a `let` further down
// the file it sat in its temporal dead zone and the container crash-looped on every boot with
// "Cannot access protocolFeeBps before initialization".
let protocolFeeBps: number | null = null;
/**
 * The escrow's own trial bounds, read once at boot. They are `public constant`s — they cannot move
 * under a running deployment — so one read per process is enough and no sweep is needed. The MCP
 * `prepare_create_trial` refuses calldata the contract would reject using these, not a copy typed
 * into this repository.
 */
let trialLimits: {
  minRunWindowSec: number;
  minBreakWindowSec: number;
  maxBreakWindowSec: number;
  maxRewardWei: bigint;
} | null = null;
// Same rule as the fee above, and the same crash if it is broken: `sweepAlloy` runs at module
// init and now reads these too, so they cannot sit below it.
let treasuryCreditWei: bigint | null = null;
let treasuryAddress: Address | null = null;

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
  // One extra `eth_call` per sweep. Cheap against the node this process already polls, and the
  // only way the published treasury figure stays the chain's instead of a copy that drifts.
  await readTreasuryCredit();

  const ids = [...scribe.state.agents.keys()];
  // Bounded fan-out. This used to be one unbounded `Promise.all`, at five `readContract` calls
  // per agent, every `ALLOY_TTL_MS` — and `registerAgent` costs only `MIN_BOND` and is never
  // removed, so anyone could add five permanent reads per two seconds to the node that the
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
// exists for. A down node must not prevent the API from starting — the watch loop retries on
// subsequent ticks, and /health reports the sync error so an operator can see what is wrong.
try {
  await scribe.sync();
} catch (err) {
  const detail = err instanceof Error ? err.message : String(err);
  console.error(`[crucible] initial sync failed (node may be down): ${detail}`);
}
scribe.hydrate();
void scribe.watch();

/**
 * Sponsor-published CIDs, from the same disclosure file the seeding path writes.
 *
 * The chain holds a digest of the spec and the suite; the readable address that resolves to the
 * files is published off-chain and recorded here by `ContentBridge`. Nothing fed this into the
 * snapshot before, so `testsCID` was permanently null and every trial said "suite not disclosed
 * yet" — a scheduled reveal that never came. An absent file is the honest empty answer. A
 * malformed one is not: it goes to the dead-letter queue, because silently returning nothing
 * would restore exactly the fault this wire exists to end.
 *
 * Measured on the deployed stack 2026-10-26, two more reasons the reveal never came: this
 * variable was read as `CRUSCIBLE_CONTENT_DIR` (no `i`) while compose sets
 * `CRUCIBLE_CONTENT_DIR`, and the `api` service had no `content` volume at all — so even the
 * right name would have resolved to a directory the writer never touches. The path shape
 * (`<dir>/disclosure/disclosure.json`) matches `DisclosureLog.open(join(dir, "disclosure"))`,
 * which is what every producer uses.
 */
const contentDir = process.env.CRUCIBLE_CONTENT_DIR ?? ".crucible-content";

function disclosedCids(): DisclosureEntry[] {
  return readDisclosure(contentDir, scribe.state.trials.values(), (message) =>
    dlq.push("disclosure.read", message),
  );
}

/**
 * Reading the pinned bytes a CID or a trial digest names.
 *
 * The disclosure map is re-read per request rather than held: a producer can pin a suite and
 * announce it at any moment, and a reader who arrived a minute early should not be told the
 * digest resolves to nothing for the rest of this process's life.
 */
const contentLookup = createContentSource(contentDir, () =>
  digestToCidMap(disclosureFileIn(contentDir), (message) => dlq.push("content.disclosure", message)),
);

/**
 * The v2 arena, when this host has one.
 *
 * A second `Scribe` over the same transport: the reader — sharding, bloom cross-check, quiet-tail
 * proof, reorg replay — is identical, and only the `source` and the reducer differ. `ARENA_ADDRESS`
 * empty is the documented state of every host today; the route then reports `projected: false`
 * rather than an empty arena, because those are different facts.
 *
 * No `cursorFile`: the arena's log volume is its own, and sharing the trials cursor would make each
 * index move the other's position.
 */
let arenaModel: ArenaModel = emptyArenaModel();
const arenaAddress = (process.env.ARENA_ADDRESS ?? "").trim();
if (arenaAddress.length > 0) {
  const arenaScribe = new Scribe({
    source: { abi: ARENA_ABI, eventNames: ARENA_EVENT_NAMES, address: arenaAddress as Address },
    chain: foundry,
    rpcUrl,
    fromBlock: optionalBlock("FROM_BLOCK"),
    pollMs: scribePollMs,
    onEvents: (events) => {
      arenaModel = replayArena(events, arenaModel);
    },
    onError: (kind, detail) => dlq.push(`scribe.arena.${kind}`, detail),
  });
  await arenaScribe.sync();
  void arenaScribe.watch();
  console.log(`[crucible] arena ${arenaAddress}`);
}

/** TeamLedger — second model over the same transport, its own address and cursor. */
let teamLedgerModel: TeamLedgerModel = emptyTeamLedgerModel();
if (teamLedgerAddress.length > 0) {
  const teamLedgerScribe = new Scribe({
    source: {
      ...TEAM_LEDGER_SOURCE,
      address: teamLedgerAddress as Address,
    },
    chain: foundry,
    rpcUrl,
    fromBlock: optionalBlock("FROM_BLOCK"),
    pollMs: scribePollMs,
    onEvents: (events) => {
      teamLedgerModel = replayTeamLedger(events, teamLedgerModel);
    },
    onError: (kind, detail) => dlq.push(`scribe.team-ledger.${kind}`, detail),
  });
  await teamLedgerScribe.sync();
  void teamLedgerScribe.watch();
  console.log(`[crucible] team-ledger ${teamLedgerAddress}`);
}

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

/**
 * Read the escrow's trial bounds: `MIN_RUN_WINDOW`, `MIN_BREAK_WINDOW`, `MAX_BREAK_WINDOW` and
 * `MAX_REWARD`. Four `eth_call`s, once, because they are public constants.
 *
 * The MCP `prepare_create_trial` builder needs them: without a bound it will encode a `breakWindow`
 * the contract reverts on, and the caller finds that out from a failed transaction rather than from
 * the tool that was supposed to help. Null on failure is allowed and is reported to the agent as
 * `limitsChecked: false` — the tool says which checks it actually did.
 */
async function readTrialLimits(): Promise<void> {
  const constant = (name: string) =>
    publicClient.readContract({
      address: trialsAddress,
      abi: [{ type: "function", name, stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] }],
      functionName: name,
    }) as Promise<bigint>;
  try {
    const [minRun, minBreak, maxBreak, maxReward] = await Promise.all([
      constant("MIN_RUN_WINDOW"),
      constant("MIN_BREAK_WINDOW"),
      constant("MAX_BREAK_WINDOW"),
      constant("MAX_REWARD"),
    ]);
    trialLimits = {
      minRunWindowSec: Number(minRun),
      minBreakWindowSec: Number(minBreak),
      maxBreakWindowSec: Number(maxBreak),
      maxRewardWei: maxReward,
    };
    console.log(
      `[crucible] trial bounds: run window >= ${trialLimits.minRunWindowSec}s, break window ` +
        `${trialLimits.minBreakWindowSec}…${trialLimits.maxBreakWindowSec}s, reward <= ${trialLimits.maxRewardWei} wei`,
    );
  } catch (err) {
    console.error(
      `[crucible] could not read the trial bounds: ${err instanceof Error ? err.message : String(err)} — ` +
        "MCP will build createTrial without checking them and will say limitsChecked:false",
    );
  }
}
await readTrialLimits();

/**
 * `credit[treasury]` — what the treasury can actually withdraw.
 *
 * The settlement fee is one income stream; the other is the treasury's share of every slashed
 * skeptic bond, which the fee arithmetic never sees. The landing page published the fee under a
 * heading a reader takes for the total, so 0.15 ETH sat beside a chain holding 0.305 and neither
 * number could be reconciled with the other. Read on the alloy sweep's clock because it moves on
 * every settlement and every slash (the fee above is a constant and is read once).
 *
 * A failed read keeps the last reading rather than publishing null: the number it replaces was a
 * real chain answer, and flapping the page on a transient RPC error is its own wrong. With no
 * reading at all it stays null — unknown is not zero, and the page must not price it as one.
 */
async function readTreasuryCredit(): Promise<void> {
  try {
    if (treasuryAddress === null) {
      treasuryAddress = (await publicClient.readContract({
        address: trialsAddress,
        abi: [{ type: "function", name: "treasury", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] }],
        functionName: "treasury",
      })) as Address;
    }
    treasuryCreditWei = (await publicClient.readContract({
      address: trialsAddress,
      abi: [
        {
          type: "function",
          name: "credit",
          stateMutability: "view",
          inputs: [{ type: "address" }],
          outputs: [{ type: "uint256" }],
        },
      ],
      functionName: "credit",
      args: [treasuryAddress],
    })) as bigint;
  } catch (err) {
    console.error(
      `[crucible] could not read credit(treasury): ${err instanceof Error ? err.message : String(err)} — ` +
        "the treasury credit stays at its last read (or unknown if never read)",
    );
  }
}

/**
 * `credit[wallet]` for an address the explorer asked about.
 *
 * Not swept: the set of wallets a visitor names is unbounded, and `registerAgent` costs
 * `MIN_BOND` and is never removed, so a per-sweep read keyed on wallet would let anyone
 * choose this process's RPC load. It is read per request, cached briefly, and the cache
 * only ever stores a success — a failed read returns null and the route says so, rather
 * than parking "unknown" behind a TTL that would make the page look stale on purpose.
 */
const CREDIT_TTL_MS = 15_000;
const CREDIT_CACHE_MAX = 256;
const creditReads = new Map<string, { at: number; wei: bigint }>();

async function readCreditOf(wallet: string): Promise<bigint | null> {
  const key = wallet.toLowerCase();
  const hit = creditReads.get(key);
  if (hit && Date.now() - hit.at < CREDIT_TTL_MS) return hit.wei;
  try {
    const wei = (await publicClient.readContract({
      address: trialsAddress,
      abi: [
        {
          type: "function",
          name: "credit",
          stateMutability: "view",
          inputs: [{ type: "address" }],
          outputs: [{ type: "uint256" }],
        },
      ],
      functionName: "credit",
      args: [key as Address],
    })) as bigint;
    if (creditReads.size >= CREDIT_CACHE_MAX) {
      // Map iteration order is insertion order, so this drops the oldest reading.
      const oldest = creditReads.keys().next().value;
      if (oldest !== undefined) creditReads.delete(oldest);
    }
    creditReads.set(key, { at: Date.now(), wei });
    return wei;
  } catch (err) {
    console.error(
      `[crucible] could not read credit(${key}): ${err instanceof Error ? err.message : String(err)} — ` +
        "the explorer reports the claim as unread rather than zero",
    );
    return null;
  }
}

/**
 * Issuers whose signed statement counts as a human attestation. Empty by default: no issuer
 * exists for this deployment until the owner names one, and the evidence route reports the
 * source as unconfigured rather than pretending a wallet is unattested-by-choice.
 */
const humanAttestors = (process.env.IDENTITY_ATTESTORS ?? "")
  .split(",")
  .map((a) => a.trim())
  .filter((a) => /^0x[0-9a-fA-F]{40}$/.test(a));

/**
 * The isolated clean.sdk sidecar (`integrations/clean-sdk`). Empty means no Passport source
 * is configured; the evidence route reports that state rather than omitting the source. The
 * sidecar is a read-only eligibility check — it never sends a transaction and holds no key.
 */
const passportEligibility = createPassportSource(process.env.CLEAN_PASSPORT_URL ?? null);

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
  disclosure: disclosedCids,
  contentLookup,
  /**
   * Only when a scribe is actually running. Passing the model unconditionally made the route
   * report `projected: true` over an empty Map, which reads as "an arena with no trials" — the
   * exact confusion the route's `projected` flag exists to prevent.
   */
  arena: arenaAddress.length > 0 ? () => arenaModel : undefined,
  team: teamLedgerAddress.length > 0 ? () => teamLedgerModel : undefined,
  funderUrl: funderUrl.length > 0 ? funderUrl : undefined,
  /**
   * The sponsorship queue, and the gate that says who may read it.
   *
   * The queue is always on: every application is recorded, and the owner is
   * notified through the webhook whether or not an owner address is configured
   * here. The address list only decides who can read the queue back over HTTP.
   */
  sponsorship: {
    queue: new SponsorshipQueue(),
    owners: new OwnerGate(ownerAddresses),
    ...(sponsorshipNotifier
      ? {
          notify: async (application) => {
            await sponsorshipNotifier.send({ message: sponsorshipMessage(application) });
          },
        }
      : {}),
  },
  // The hall's txHashes are only checkable against one chain and one contract, and the
  // read model cannot infer either — this process is the only party that knows them.
  proofSource: { chain: foundry.name, chainId: foundry.id, trialsAddress },
  alloyState: (agentId) => alloyById.get(agentId) ?? UNKNOWN_ALLOY,
  // The chain's own fee constant, so the published books are the ones the
  // contract charges rather than ones this process keeps a copy of.
  protocolFeeBps: () => protocolFeeBps,
  // The treasury's pull-ledger credit, read on the same clock as the alloy sweep. Null until a
  // read lands, so the page shows "—" rather than the fee dressed up as the whole income.
  treasuryCreditWei: () => treasuryCreditWei,
  // Per-wallet claims for the escrow explorer, read on request rather than swept.
  creditOf: readCreditOf,
  // The bounds the MCP builders check against, read once from the contract.
  trialLimits,
  humanAttestors,
  passportEligibility,
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
  // `/mcp` has its own bucket; the global read limiter skips that path.
  mcpRateLimit: {
    limit: positiveInt("MCP_RATE_LIMIT", 30),
    windowMs: 60_000,
    burst: positiveInt("MCP_RATE_BURST", 10),
  },
  voice,
  frenchy,
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
  console.log(
    frenchy
      ? `[crucible] frenchy: brain on (${frenchy.llm.model})${frenchy.tts ? " + premium TTS" : ""}`
      : "[crucible] frenchy: brain off (set FRENCHY_LLM_API_KEY to enable)",
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
