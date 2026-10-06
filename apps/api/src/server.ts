import { serve } from "@hono/node-server";
import { foundry } from "viem/chains";
import { createPublicClient, http } from "viem";
import { Scribe } from "@crucible/indexer";
import { createApp } from "./app.js";

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

const publicClient = createPublicClient({ chain: foundry, transport: http(rpcUrl) });

const scribe = new Scribe({
  trialsAddress,
  alloyAddress,
  chain: foundry,
  rpcUrl,
  fromBlock: process.env.FROM_BLOCK ? BigInt(process.env.FROM_BLOCK) : 0n,
});

await scribe.sync();
scribe.hydrate();
void scribe.watch();

const app = createApp({
  getModel: () => scribe.state,
  alloyState: (agentId) => {
    const agent = scribe.state.agents.get(agentId);
    // Cheap local approximation: an Alloy exists once the agent has any record.
    return {
      locked: agent ? agent.wins > 0 || agent.slashes > 0 : false,
      tokenUri: null,
    };
  },
});

serve({ fetch: app.fetch, port }, (info) => {
  console.log(`[crucible] api listening on :${info.port}`);
  console.log(`[crucible] indexing ${trialsAddress}`);
});
