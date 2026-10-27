import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { serve } from "@hono/node-server";
import type { AddressInfo } from "node:net";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { createApp } from "../src/app.js";
import type { ReadModel } from "@crucible/indexer";

/**
 * The bounds the `prepare_*` tools are allowed to ignore.
 *
 * The first external MCP agent run (gate 770) asked for a 30-minute break window, was handed
 * calldata, and paid for a transaction that reverted `BadWindow`. The builder knew the shape of the
 * call and nothing about the contract's floors, so the failure surfaced at the worst moment — after
 * the agent had spent gas. These tests hold the two refusals that replace that: a window outside the
 * chain's own bounds is refused before any calldata exists, and a host that has not read its chain
 * id refuses to build anything at all, because unsigned calldata with no chain named is a signature
 * waiting to land on the wrong network.
 */

const TRIALS = "0x4444444444444444444444444444444444444444";
const model = {
  trials: new Map(),
  agents: new Map(),
  runs: new Map(),
  disputes: new Map(),
  appliedLogs: new Set(),
  version: 0,
} satisfies ReadModel;

/** What the contract publishes as constants; these numbers come from `CrucibleTrials.sol:151-153`. */
const LIMITS = {
  minRunWindowSec: 3_600,
  minBreakWindowSec: 3_600,
  maxBreakWindowSec: 7 * 86_400,
  maxRewardWei: 1_000n * 10n ** 18n,
};

const handles: { server: ReturnType<typeof serve>; client: Client }[] = [];

async function surface(deps: Parameters<typeof createApp>[0]): Promise<Client> {
  const app = createApp(deps, { rateLimit: false });
  const server = await new Promise<ReturnType<typeof serve>>((resolve) => {
    const handle = serve({ fetch: app.fetch, port: 0 }, () => resolve(handle));
  });
  const port = (server.address() as AddressInfo).port;
  const client = new Client({ name: "crucible-limits-test", version: "0.0.0" });
  await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`)));
  handles.push({ server, client });
  return client;
}

function textOf(result: { content?: { type: string; text?: string }[] }): Record<string, unknown> {
  const first = result.content?.find((c) => c.type === "text");
  return JSON.parse(first?.text ?? "{}");
}

function isError(result: { isError?: boolean }) {
  return result.isError === true;
}

const validCreate = {
  rewardEth: "0.01",
  specDigest: `0x${"11".repeat(32)}`,
  testsDigest: `0x${"22".repeat(32)}`,
  deadlineHours: 2,
  breakWindowHours: 1,
};

let withLimits: Client;
let withoutChain: Client;
let withoutLimits: Client;

beforeAll(async () => {
  const base = {
    getModel: () => model,
    indexStatus: () => ({ headTimestamp: 1_800_000_000 }),
  };
  withLimits = await surface({
    ...base,
    proofSource: { chain: "anvil", chainId: 31337, trialsAddress: TRIALS },
    trialLimits: LIMITS,
  });
  withoutLimits = await surface({
    ...base,
    proofSource: { chain: "anvil", chainId: 31337, trialsAddress: TRIALS },
  });
  // A host that knows which contract it reads but has never read its chain id: the address must pass
  // the first guard so the chain-id refusal is the one that answers.
  withoutChain = await surface({
    ...base,
    proofSource: { chain: "anvil", chainId: undefined as unknown as number, trialsAddress: TRIALS },
    trialLimits: LIMITS,
  });
});

afterAll(async () => {
  for (const h of handles) {
    await h.client.close();
    await new Promise<void>((resolve) => h.server.close(() => resolve()));
  }
});

describe("createTrial bounds, checked against the chain's numbers", () => {
  it("builds calldata inside every bound and says it checked", async () => {
    const out = textOf(await withLimits.callTool({ name: "prepare_create_trial", arguments: validCreate }));
    expect(out.unsigned).toBe(true);
    expect(out.limitsChecked).toBe(true);
    expect(out.breakWindow).toBe(3_600);
  });

  it("refuses a break window below MIN_BREAK_WINDOW instead of handing back a revert", async () => {
    const result = await withLimits.callTool({
      name: "prepare_create_trial",
      arguments: { ...validCreate, breakWindowHours: 0.5 },
    });
    expect(isError(result)).toBe(true);
    expect(String(result.content?.[0]?.text)).toMatch(/MIN_BREAK_WINDOW/);
    expect(String(result.content?.[0]?.text)).toMatch(/BadWindow/);
  });

  it("refuses a deadline inside MIN_RUN_WINDOW", async () => {
    const result = await withLimits.callTool({
      name: "prepare_create_trial",
      arguments: { ...validCreate, deadlineHours: 0.5 },
    });
    expect(isError(result)).toBe(true);
    expect(String(result.content?.[0]?.text)).toMatch(/MIN_RUN_WINDOW/);
  });

  it("refuses a reward above MAX_REWARD", async () => {
    const result = await withLimits.callTool({
      name: "prepare_create_trial",
      arguments: { ...validCreate, rewardEth: "2000" },
    });
    expect(isError(result)).toBe(true);
    expect(String(result.content?.[0]?.text)).toMatch(/MAX_REWARD/);
  });

  it("admits it checked nothing when the host never read the bounds", async () => {
    const out = textOf(await withoutLimits.callTool({ name: "prepare_create_trial", arguments: validCreate }));
    expect(out.limitsChecked).toBe(false);
    expect(out.unsigned).toBe(true);
    // The refusal would be a lie here: this host has no numbers, so it must not claim safety —
    // but it also must not silently imply it validated the window.
  });

  it("still refuses an out-of-range window when the caller retries with the same shape", async () => {
    // The second call is the one that matters: a refusal that only fires once would be state, not a
    // check.
    const first = await withLimits.callTool({
      name: "prepare_create_trial",
      arguments: { ...validCreate, breakWindowHours: 0.25 },
    });
    const second = await withLimits.callTool({
      name: "prepare_create_trial",
      arguments: { ...validCreate, breakWindowHours: 0.25 },
    });
    expect(isError(first)).toBe(true);
    expect(isError(second)).toBe(true);
  });
});

describe("a builder with no chain bound", () => {
  for (const name of ["prepare_create_trial", "prepare_register_agent", "prepare_claim_trial", "prepare_withdraw"]) {
    it(`${name} refuses when the host has not read its chain id`, async () => {
      const args =
        name === "prepare_register_agent"
          ? { metadataURI: "ipfs://x", runner: `0x${"77".repeat(20)}`, stakeEth: "0.05" }
          : name === "prepare_claim_trial"
            ? { trialId: 1 }
            : name === "prepare_create_trial"
              ? validCreate
              : {};
      const result = await withoutChain.callTool({ name, arguments: args });
      expect(isError(result)).toBe(true);
      expect(String(result.content?.[0]?.text)).toMatch(/chain id/);
    });
  }

  it("does not leak a calldata payload when it refuses", async () => {
    const result = await withoutChain.callTool({ name: "prepare_withdraw", arguments: {} });
    expect(String(result.content?.[0]?.text)).not.toMatch(/0x[0-9a-f]{8}/);
  });
});
