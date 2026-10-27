/**
 * MCP endpoint — the agent surface, mounted on the API it already reads.
 *
 * Eleven tools: five read the same snapshot the web renders, two score a wallet from the same
 * evidence bundle, and four return **unsigned** transaction calldata. No tool holds a key, signs
 * anything, or moves money; ADR-0006 keeps the chain key out of the API, and this surface does
 * not change that. The transaction builders use the same ABI the web uses, so an agent and a
 * browser produce identical calldata.
 *
 * Subscriptions are real: a client subscribes to `crucible://snapshot` or `crucible://hall`,
 * and the server sends `notifications/resources/updated` when the shared tick's signature moves.
 * The poll is against the in-process read model, not a second index.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { SubscribeRequestSchema, UnsubscribeRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { encodeFunctionData, isAddress, parseEther, type Address, type Hex } from "viem";
import { z } from "zod";
import { TRIALS_ABI } from "@crucible/smith";
import type { AlloyState, ApiSnapshot, ReadModel } from "@crucible/indexer";
import { decide, scoreWallet } from "./identity.js";

export interface TrialLimits {
  /** `MIN_RUN_WINDOW`, seconds — a deadline at least this far out or `createTrial` reverts. */
  minRunWindowSec: number;
  /** `MIN_BREAK_WINDOW`, seconds. */
  minBreakWindowSec: number;
  /** `MAX_BREAK_WINDOW`, seconds. */
  maxBreakWindowSec: number;
  /** `MAX_REWARD`, wei — the per-trial ceiling the contract enforces. */
  maxRewardWei: bigint;
}

export interface McpContext {
  trialAddress: string | null;
  chainId: number | null;
  snapshot: () => ApiSnapshot;
  /** The shared tick's change signal; a resource update is sent when this moves. */
  signature: () => string;
  getModel: () => ReadModel;
  alloyState?: (agentId: number) => AlloyState | null;
  now: () => number | null;
  /**
   * The bounds the escrow enforces, read off the chain.
   *
   * The `prepare_*` tools hand a caller calldata it will sign and broadcast; a builder that does not
   * know `MIN_BREAK_WINDOW` will cheerfully produce a `createTrial` the contract rejects with
   * `BadWindow`, and the agent learns that only from a reverted transaction with a reason it has to
   * decode. Measured 2026-10-27 by the first external MCP agent run: it asked for a 30-minute break
   * window, got calldata, and paid for a revert. Absent means this host never read them — then the
   * tool says so instead of implying the numbers were checked.
   */
  limits?: TrialLimits | null;
}

const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const DIGEST = /^0x[0-9a-fA-F]{64}$/;

function ok(value: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }] };
}

function fail(message: string) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify({ error: message }, null, 2) }],
    isError: true,
  };
}

/**
 * Refuse to build calldata whose chain the caller cannot check.
 *
 * A `prepare_*` answer with no chain id is a signature waiting to be replayed: the caller signs
 * bytes for one `to` on a chain nobody named. This host normally does know — it publishes the chain
 * with the hall's proofs — and the first external MCP agent run found the case where it does not:
 * the tool returned no chain id at all, and the client had to be the one to stop.
 */
function requireChainId(ctx: McpContext): ReturnType<typeof fail> | null {
  // `null` is the only way this can be unread: the caller in `app.ts` collapses undefined to null.
  if (ctx.chainId === null) {
    return fail("this host has not read its chain id; refusing to build unsigned calldata with no chain bound to it");
  }
  return null;
}

function requireTrialAddress(ctx: McpContext): string | null {
  if (!ctx.trialAddress || !ADDRESS.test(ctx.trialAddress)) return null;
  return ctx.trialAddress;
}

function buildServer(ctx: McpContext, subscriptions: Set<string>): McpServer {
  const server = new McpServer(
    { name: "crucible", version: "0.1.0" },
    { capabilities: { tools: {}, resources: { subscribe: true } } },
  );

  server.registerResource(
    "snapshot",
    "crucible://snapshot",
    {
      title: "Crucible snapshot",
      description: "The same snapshot /snapshot serves: trials, agents, hall, counts, economics.",
      mimeType: "application/json",
    },
    async (uri) => ({
      contents: [
        {
          uri: uri.href,
          mimeType: "application/json",
          text: JSON.stringify(ctx.snapshot(), null, 2),
        },
      ],
    }),
  );

  server.registerResource(
    "hall",
    "crucible://hall",
    {
      title: "Crucible hall",
      description: "The leaderboard rows /hall serves, with the same meta source.",
      mimeType: "application/json",
    },
    async (uri) => ({
      contents: [
        {
          uri: uri.href,
          mimeType: "application/json",
          text: JSON.stringify({ hall: ctx.snapshot().hall }, null, 2),
        },
      ],
    }),
  );

  server.server.setRequestHandler(SubscribeRequestSchema, async (request) => {
    subscriptions.add(request.params.uri);
    return {};
  });
  server.server.setRequestHandler(UnsubscribeRequestSchema, async (request) => {
    subscriptions.delete(request.params.uri);
    return {};
  });

  server.registerTool(
    "list_trials",
    {
      title: "List trials",
      description: "Trials from the read model, newest-first as the snapshot orders them.",
      inputSchema: { limit: z.number().int().min(1).max(200).optional() },
    },
    async ({ limit }) => {
      const snap = ctx.snapshot();
      return ok({
        trials: snap.trials.slice(0, limit ?? 50),
        counts: snap.counts,
        asOf: snap.now,
        trialsAddress: ctx.trialAddress,
      });
    },
  );

  server.registerTool(
    "get_trial",
    { title: "Get trial", description: "One trial by id.", inputSchema: { id: z.number().int().nonnegative() } },
    async ({ id }) => {
      const trial = ctx.snapshot().trials.find((t) => t.id === id);
      return trial ? ok(trial) : fail(`no trial ${id} in the read model`);
    },
  );

  server.registerTool(
    "list_agents",
    {
      title: "List agents",
      description: "Registered agents with their alloy tier when the host read the registry.",
      inputSchema: { limit: z.number().int().min(1).max(200).optional() },
    },
    async ({ limit }) => ok({ agents: ctx.snapshot().agents.slice(0, limit ?? 50) }),
  );

  server.registerTool(
    "get_agent",
    { title: "Get agent", description: "One agent by id.", inputSchema: { id: z.number().int().nonnegative() } },
    async ({ id }) => {
      const agent = ctx.snapshot().agents.find((a) => a.id === id);
      return agent ? ok(agent) : fail(`no agent ${id} in the read model`);
    },
  );

  server.registerTool(
    "hall",
    { title: "Hall", description: "The leaderboard rows and their proof meta.", inputSchema: {} },
    async () => ok({ hall: ctx.snapshot().hall, trialsAddress: ctx.trialAddress, chainId: ctx.chainId }),
  );

  const risk = (wallet: string) => {
    const model = ctx.getModel();
    const score = scoreWallet(model, (id) => ctx.alloyState?.(id) ?? null, wallet, ctx.now());
    return { score, decision: decide(score) };
  };

  server.registerTool(
    "risk_score",
    {
      title: "Risk score",
      description:
        "Sybil-risk posterior from on-chain evidence only. No attestation or Passport query is supplied here.",
      inputSchema: { wallet: z.string() },
    },
    async ({ wallet }) => {
      if (!ADDRESS.test(wallet)) return fail("wallet must be a 0x-prefixed 20-byte Ethereum address");
      return ok({ ...risk(wallet), unqualified: "no attestation or Passport query supplied" });
    },
  );

  server.registerTool(
    "evidence",
    {
      title: "Evidence",
      description: "The score's signal breakdown, with unconfigured sources named rather than omitted.",
      inputSchema: { wallet: z.string() },
    },
    async ({ wallet }) => {
      if (!ADDRESS.test(wallet)) return fail("wallet must be a 0x-prefixed 20-byte Ethereum address");
      const result = risk(wallet);
      return ok({
        wallet,
        ...result,
        sources: {
          alloy: { configured: Boolean(ctx.alloyState) },
          passport: { configured: false, reason: "not queried on the MCP surface" },
          attestation: { configured: false, reason: "not queried on the MCP surface" },
        },
      });
    },
  );

  server.registerTool(
    "prepare_create_trial",
    {
      title: "Prepare createTrial",
      description:
        "Unsigned createTrial calldata. The reward is msg.value; the caller signs and sends it.",
      inputSchema: {
        rewardEth: z.string(),
        specDigest: z.string(),
        testsDigest: z.string(),
        deadlineHours: z.number().positive(),
        breakWindowHours: z.number().positive(),
      },
    },
    async ({ rewardEth, specDigest, testsDigest, deadlineHours, breakWindowHours }) => {
      const to = requireTrialAddress(ctx);
      if (!to) return fail("no trials address is configured on this host");
      const chainRefusal = requireChainId(ctx);
      if (chainRefusal) return chainRefusal;
      if (!DIGEST.test(specDigest) || !DIGEST.test(testsDigest)) {
        return fail("specDigest and testsDigest must be 0x-prefixed 32-byte hex");
      }
      try {
        const rewardWei = parseEther(rewardEth);
        if (rewardWei <= 0n) return fail("rewardEth must be positive");
        const now = ctx.now() ?? Math.floor(Date.now() / 1000);
        const deadline = now + Math.round(deadlineHours * 3600);
        const breakWindow = Math.round(breakWindowHours * 3600);

        // Checked against the contract's own numbers, not a copy of them typed in here.
        const limits = ctx.limits ?? null;
        if (limits) {
          if (rewardWei > limits.maxRewardWei) {
            return fail(`rewardEth exceeds MAX_REWARD (${limits.maxRewardWei} wei)`);
          }
          if (deadline < now + limits.minRunWindowSec) {
            return fail(`deadline is inside MIN_RUN_WINDOW (${limits.minRunWindowSec}s); createTrial would revert BadDeadline`);
          }
          if (breakWindow < limits.minBreakWindowSec || breakWindow > limits.maxBreakWindowSec) {
            return fail(
              `breakWindowHours=${breakWindowHours} is outside MIN_BREAK_WINDOW…MAX_BREAK_WINDOW ` +
                `(${limits.minBreakWindowSec}s…${limits.maxBreakWindowSec}s); createTrial would revert BadWindow`,
            );
          }
        }

        const data = encodeFunctionData({
          abi: TRIALS_ABI,
          functionName: "createTrial",
          args: [rewardWei, specDigest as Hex, testsDigest as Hex, BigInt(deadline), BigInt(breakWindow)],
        });
        return ok({
          unsigned: true,
          to,
          chainId: ctx.chainId,
          data,
          value: rewardWei.toString(),
          deadline,
          breakWindow,
          // False is an admission, not a silence: the caller is told the bounds were never read.
          limitsChecked: Boolean(limits),
        });
      } catch (err) {
        return fail(`could not build createTrial: ${err instanceof Error ? err.message : String(err)}`);
      }
    },
  );

  server.registerTool(
    "prepare_register_agent",
    {
      title: "Prepare registerAgent",
      description: "Unsigned registerAgent calldata; the stake is msg.value.",
      inputSchema: { metadataURI: z.string().min(1), runner: z.string(), stakeEth: z.string() },
    },
    async ({ metadataURI, runner, stakeEth }) => {
      const to = requireTrialAddress(ctx);
      if (!to) return fail("no trials address is configured on this host");
      const chainRefusal = requireChainId(ctx);
      if (chainRefusal) return chainRefusal;
      if (!isAddress(runner)) return fail("runner must be a 0x-prefixed 20-byte Ethereum address");
      try {
        const stakeWei = parseEther(stakeEth);
        if (stakeWei <= 0n) return fail("stakeEth must be positive");
        const data = encodeFunctionData({
          abi: TRIALS_ABI,
          functionName: "registerAgent",
          args: [metadataURI, runner as Address],
        });
        return ok({ unsigned: true, to, chainId: ctx.chainId, data, value: stakeWei.toString() });
      } catch (err) {
        return fail(`could not build registerAgent: ${err instanceof Error ? err.message : String(err)}`);
      }
    },
  );

  server.registerTool(
    "prepare_claim_trial",
    {
      title: "Prepare claimTrial",
      description: "Unsigned claimTrial calldata. The bond is msg.value; the caller signs and sends it.",
      inputSchema: { trialId: z.number().int().nonnegative() },
    },
    async ({ trialId }) => {
      const to = requireTrialAddress(ctx);
      if (!to) return fail("no trials address is configured on this host");
      const chainRefusal = requireChainId(ctx);
      if (chainRefusal) return chainRefusal;
      const data = encodeFunctionData({
        abi: TRIALS_ABI,
        functionName: "claimTrial",
        args: [BigInt(trialId)],
      });
      return ok({ unsigned: true, to, chainId: ctx.chainId, data });
    },
  );

  server.registerTool(
    "prepare_withdraw",
    {
      title: "Prepare withdraw",
      description: "Unsigned withdraw calldata for the pull ledger. Settlement never pushes ETH.",
      inputSchema: {},
    },
    async () => {
      const to = requireTrialAddress(ctx);
      if (!to) return fail("no trials address is configured on this host");
      const chainRefusal = requireChainId(ctx);
      if (chainRefusal) return chainRefusal;
      const data = encodeFunctionData({ abi: TRIALS_ABI, functionName: "withdraw", args: [] });
      return ok({ unsigned: true, to, chainId: ctx.chainId, data });
    },
  );

  return server;
}

/**
 * Poll the shared tick, not a second clock.
 *
 * `signature` is the same value the SSE stream uses to decide a frame changed, so an MCP
 * subscriber and a browser see the same transitions. The interval is unref'd so a process with
 * no other work can exit, and it is cleared when the transport closes.
 */
function startPoller(server: McpServer, ctx: McpContext, subscriptions: Set<string>): NodeJS.Timeout {
  let last = ctx.signature();
  const timer = setInterval(() => {
    if (subscriptions.size === 0) return;
    const signature = ctx.signature();
    if (signature === last) return;
    last = signature;
    for (const uri of subscriptions) {
      void server.server.sendResourceUpdated({ uri }).catch(() => {
        // A closed stream is not a reason to stop polling the others.
      });
    }
  }, 500);
  timer.unref?.();
  return timer;
}

/**
 * The Hono-compatible request handler. Stateful sessions are held in this process; the API is a
 * single writer with an in-memory read model (ADR-0008), so there is no session store to scale.
 */
export function createMcpHandler(ctx: McpContext): (request: Request) => Promise<Response> {
  const sessions = new Map<string, WebStandardStreamableHTTPServerTransport>();

  return async (request: Request): Promise<Response> => {
    const sessionId = request.headers.get("mcp-session-id");
    if (sessionId) {
      const existing = sessions.get(sessionId);
      if (!existing) {
        return Response.json(
          { error: "unknown MCP session; send an initialize request without mcp-session-id" },
          { status: 404 },
        );
      }
      return existing.handleRequest(request);
    }

    const subscriptions = new Set<string>();
    const server = buildServer(ctx, subscriptions);
    let initializedId: string | null = null;
    const transport: WebStandardStreamableHTTPServerTransport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: () => crypto.randomUUID(),
      onsessioninitialized: (id) => {
        initializedId = id;
        sessions.set(id, transport);
      },
      onsessionclosed: (id) => {
        sessions.delete(id);
      },
    });
    const timer = startPoller(server, ctx, subscriptions);
    transport.onclose = () => {
      clearInterval(timer);
      if (initializedId) sessions.delete(initializedId);
    };

    await server.connect(transport);
    return transport.handleRequest(request);
  };
}
