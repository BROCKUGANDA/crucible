import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { serve } from "@hono/node-server";
import type { AddressInfo } from "node:net";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { ResourceUpdatedNotificationSchema } from "@modelcontextprotocol/sdk/types.js";
import { emptyModel, type AgentRow, type TrialRow } from "@crucible/indexer";
import { createApp } from "../src/app.js";

/**
 * The MCP surface is real if a client can list it, call it and receive a subscription update
 * over the deployed transport. These tests use the SDK's own client against a real HTTP server,
 * not a hand-built JSON-RPC shape.
 */
const OPERATOR = "0x" + "22".repeat(20);
const TRIALS = "0x" + "44".repeat(20);

const model = emptyModel();
const trial: TrialRow = {
  id: 7,
  sponsor: "0x" + "11".repeat(20),
  specCID: null,
  testsCID: null,
  specDigest: "0x" + "33".repeat(32),
  testsDigest: "0x" + "55".repeat(32),
  rewardWei: 10n ** 16n,
  bondWei: 10n ** 15n,
  payoutWei: null,
  createdAt: 1_799_000_000,
  deadline: 1_800_000_000,
  breakWindow: 86_400,
  agentId: 3,
  runHash: null,
  runAt: null,
  breakSkeptic: null,
  breakStakeWei: null,
  breakProofCID: null,
  status: "open",
  verdict: "none",
  disputeOpenedAt: null,
  settledAt: null,
};
const agent: AgentRow = {
  id: 3,
  operator: OPERATOR,
  runner: "0x" + "66".repeat(20),
  metadataURI: "ipfs://mcp-agent",
  stakeWei: 10n ** 15n,
  active: 1,
  wins: 0,
  survived: 0,
  slashes: 0,
  identityAgentId: null,
  identity: null,
  settlements: [],
};
model.trials.set(trial.id, trial);
model.agents.set(agent.id, agent);

let server: ReturnType<typeof serve>;
let client: Client;
let port = 0;

beforeAll(async () => {
  const app = createApp(
    {
      getModel: () => model,
      proofSource: { chain: "anvil", chainId: 31337, trialsAddress: TRIALS },
      indexStatus: () => ({ headTimestamp: 1_800_000_000 }),
    },
    { rateLimit: false },
  );
  server = await new Promise<ReturnType<typeof serve>>((resolve) => {
    let handle: ReturnType<typeof serve>;
    handle = serve({ fetch: app.fetch, port: 0 }, () => resolve(handle));
  });
  port = (server.address() as AddressInfo).port;
  client = new Client({ name: "crucible-test", version: "0.0.0" });
  await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`)));
});

afterAll(async () => {
  await client?.close();
  await new Promise<void>((resolve) => server?.close(() => resolve()));
});

function textOf(result: { content?: { type: string; text?: string }[] }): any {
  const first = result.content?.find((c) => c.type === "text");
  return JSON.parse(first?.text ?? "{}");
}

describe("MCP surface", () => {
  it("lists eleven tools and the subscription resources", async () => {
    const tools = await client.listTools();
    expect(tools.tools.map((t) => t.name).sort()).toEqual(
      [
        "evidence",
        "get_agent",
        "get_trial",
        "hall",
        "list_agents",
        "list_trials",
        "prepare_claim_trial",
        "prepare_create_trial",
        "prepare_register_agent",
        "prepare_withdraw",
        "risk_score",
      ].sort(),
    );
    const resources = await client.listResources();
    expect(resources.resources.map((r) => r.uri).sort()).toEqual(["crucible://hall", "crucible://snapshot"]);
  });

  it("reads the same trial the snapshot serves", async () => {
    const out = textOf(await client.callTool({ name: "list_trials", arguments: { limit: 5 } }));
    expect(out.trials).toHaveLength(1);
    expect(out.trials[0].id).toBe(7);
    expect(out.trialsAddress).toBe(TRIALS);
  });

  it("returns unsigned calldata, never a key or a signature", async () => {
    const out = textOf(
      await client.callTool({
        name: "prepare_create_trial",
        arguments: {
          rewardEth: "0.01",
          specDigest: "0x" + "11".repeat(32),
          testsDigest: "0x" + "22".repeat(32),
          deadlineHours: 2,
          breakWindowHours: 1,
        },
      }),
    );
    expect(out.unsigned).toBe(true);
    expect(out.to).toBe(TRIALS);
    expect(out.value).toBe("10000000000000000");
    expect(out.data).toMatch(/^0x[0-9a-f]+$/);
    expect(JSON.stringify(out)).not.toMatch(/privateKey|signature/i);
  });

  it("sends a resource update when the shared tick moves", async () => {
    const updates: string[] = [];
    client.setNotificationHandler(ResourceUpdatedNotificationSchema, (notification) => {
      updates.push(notification.params.uri);
    });
    await client.subscribeResource({ uri: "crucible://snapshot" });

    trial.status = "settled";
    trial.verdict = "paid";
    trial.settledAt = 1_800_000_100;
    model.version += 1;

    const deadline = Date.now() + 4000;
    while (updates.length === 0 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    expect(updates).toContain("crucible://snapshot");

    const read = await client.readResource({ uri: "crucible://snapshot" });
    const snapshot = JSON.parse((read.contents[0] as { text: string }).text);
    expect(snapshot.trials[0].status).toBe("settled");
  });
});
