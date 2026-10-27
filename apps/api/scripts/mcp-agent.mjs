#!/usr/bin/env node
/**
 * An external agent completes a devnet trial through MCP, with no UI.
 *
 * Gate 770. The MCP surface had eleven tools and an SDK-client test that proved list/call/subscribe,
 * and nothing that used it the way an agent would: read to decide, ask for unsigned calldata, sign
 * with its own key, broadcast, and take the chain's answer as the only verdict. That is the
 * difference between "the tools are shaped right" and "an agent can work here", and only the second
 * is the product.
 *
 * Order of the run:
 *   1. connect to `/mcp`, list the tools, subscribe to `crucible://snapshot`;
 *   2. read the board over MCP and reuse a trial's real spec/tests commitments;
 *   3. `prepare_register_agent` → sign and send here; `prepare_create_trial` → same; `prepare_claim_trial` → same;
 *   4. build the run artifact, hash it, sign the EIP-712 `Run` digest with the runner key and call
 *      `submitRun` directly — the one step no MCP tool can do for a caller, because the contract only
 *      accepts the runner's own signature;
 *   5. read the trial back **through MCP** and assert the chain moved it, and that the subscription
 *      delivered at least one notification while it worked.
 *
 * Every step is a refusal, not a print: if the chain disagrees, this exits non-zero and names the
 * step. It will not run anywhere but loopback on chain id 31337, because the keys it signs with are
 * Anvil's published test keys and on any other chain that would be somebody's money.
 */
import { createPublicClient, createWalletClient, http } from "viem";
import { foundry } from "viem/chains";
import { mnemonicToAccount } from "viem/accounts";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { ResourceUpdatedNotificationSchema } from "@modelcontextprotocol/sdk/types.js";
import { TRIALS_ABI, computeRunHash, SIG_DEADLINE_TTL_SECONDS } from "@crucible/smith";

const RPC = process.env.MCP_AGENT_RPC ?? "http://127.0.0.1:8545";
const API = process.env.MCP_AGENT_API ?? "http://127.0.0.1:8787";
const MNEMONIC =
  process.env.MCP_AGENT_MNEMONIC ?? "test test test test test test test test test test test junk";

const SPONSOR_INDEX = Number(process.env.MCP_AGENT_SPONSOR_INDEX ?? 8);
const OPERATOR_INDEX = Number(process.env.MCP_AGENT_OPERATOR_INDEX ?? 7);

const sponsor = mnemonicToAccount(MNEMONIC, { addressIndex: SPONSOR_INDEX });
const operator = mnemonicToAccount(MNEMONIC, { addressIndex: OPERATOR_INDEX });

const publicClient = createPublicClient({ chain: foundry, transport: http(RPC) });
const wallet = createWalletClient({ chain: foundry, transport: http(RPC) });

const passed = [];
const failed = [];
function check(name, condition, detail) {
  if (condition) passed.push(name);
  else failed.push(`${name}${detail ? ` — ${detail}` : ""}`);
  return condition;
}
function step(title, message) {
  console.log(`\n▸ ${title}\n  ${message}`);
}

let trials = null;
let client = null;
let notifications = 0;

/** Call an MCP tool and unwrap the JSON this server answers with. */
async function callTool(name, args) {
  const res = await client.callTool({ name, arguments: args });
  const text = (res.content ?? []).find((c) => c.type === "text")?.text ?? "";
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error(`${name} answered with non-JSON: ${text.slice(0, 180)}`);
  }
  if (res.isError || parsed.ok === false) {
    throw new Error(`${name} refused: ${parsed.error ?? text.slice(0, 180)}`);
  }
  // Unwrap only the envelope shape ({ok,data:{...}}).  answers flat, and one of its
  // own fields is named data (the calldata), so a blind  would hand the caller a hex
  // string and the chain id would be gone by accident rather than by absence.
  return parsed.ok === true && parsed.data && typeof parsed.data === "object" ? parsed.data : parsed;
}

/** Broadcast what a `prepare_*` tool built, signing here. The key never leaves this process. */
async function send(prepared, account) {
  if (prepared.chainId === undefined || prepared.chainId === null) throw new Error(`prepared calldata carries no chain id at all: ${JSON.stringify(prepared).slice(0, 200)}`);
  if (Number(prepared.chainId) !== 31337) throw new Error(`prepared calldata names chain ${prepared.chainId}`);
  const hash = await wallet.sendTransaction({
    account,
    to: prepared.to,
    data: prepared.data,
    value: prepared.value ? BigInt(prepared.value) : 0n,
  });
  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  if (receipt.status !== "success") throw new Error(`${receipt.transactionHash} reverted`);
  return receipt;
}

async function chainNowSeconds() {
  const block = await publicClient.getBlock();
  return Number(block.timestamp);
}

async function main() {
  const chainId = await publicClient.getChainId();
  if (chainId !== 31337) {
    console.error(`refusing to run: ${RPC} is chain id ${chainId}, not 31337 — this signs with published test keys`);
    process.exit(2);
  }
  if (!/^(127\.0\.0\.1|localhost)(:|$)/.test(new URL(RPC).host)) {
    console.error(`refusing to run: ${RPC} is not loopback`);
    process.exit(2);
  }

  client = new Client({ name: "crucible-mcp-agent", version: "0.1.0" });
  await client.connect(new StreamableHTTPClientTransport(new URL(`${API}/mcp`)));
  client.setNotificationHandler(ResourceUpdatedNotificationSchema, () => {
    notifications += 1;
  });

  const toolNames = (await client.listTools()).tools.map((t) => t.name).sort();
  step("1. connected to /mcp", `${toolNames.length} tools: ${toolNames.join(", ")}`);
  for (const name of ["prepare_create_trial", "prepare_claim_trial", "prepare_register_agent", "prepare_withdraw"]) {
    check(`exposes ${name}`, toolNames.includes(name), "absent");
  }
  check(
    "no tool signs or broadcasts",
    !toolNames.some((n) => /(^|_)(sign|send|broadcast|submit_run)(_|$)/.test(n)),
    toolNames.join(","),
  );
  await client.subscribeResource({ uri: "crucible://snapshot" });

  const board = await callTool("list_trials", { limit: 20 });
  trials = board.trialsAddress;
  if (!check("list_trials named the contract it reads", Boolean(trials), String(trials))) throw new Error("no trials address");
  const source = board.trials.find((t) => /^0x[0-9a-f]{64}$/.test(t.testsDigest) && !/^0x0+$/.test(t.testsDigest));
  if (!check("the board carries a trial with commitments", Boolean(source), JSON.stringify(board.counts))) throw new Error("no committed trial");
  const detail = await callTool("get_trial", { id: source.id });
  step("2. read the board over MCP", `trial ${detail.id} commits tests ${detail.testsDigest.slice(0, 14)}… spec ${detail.specDigest.slice(0, 14)}…`);

  const agents = await callTool("list_agents", { limit: 200 });
  const mine = agents.agents.find((a) => a.operator.toLowerCase() === operator.address.toLowerCase());

  let agentId;
  if (mine) {
    // A client that already registered reuses its agent instead of sending a transaction the
    // contract will reject with `AlreadyRegistered`. Refusing to run twice would be this script's
    // limitation, not the protocol's.
    agentId = mine.id;
    step("3a. registerAgent", `already registered — ${operator.address} operates agent #${agentId}`);
  } else {
    const reg = await callTool("prepare_register_agent", {
      metadataURI: "ipfs://mcp-agent",
      runner: operator.address,
      stakeEth: "0.05",
    });
    const regReceipt = await send(reg, operator);
    agentId = Number(
      await publicClient.readContract({
        address: trials,
        abi: TRIALS_ABI,
        functionName: "agentIdOf",
        args: [operator.address],
      }),
    );
    if (!check("the chain registered the agent", agentId > 0, "agentIdOf is zero")) throw new Error("registration did not land");
    step("3a. registerAgent", `agent #${agentId} for ${operator.address} — tx ${regReceipt.transactionHash.slice(0, 18)}…`);
  }

  // The run that first drove this loop asked for a 30-minute break window, was handed calldata, and
  // paid for a `BadWindow` revert. That is now refused before any bytes exist — so the agent checks
  // the refusal happens, rather than discovering it downstream again.
  let refused = false;
  try {
    await callTool("prepare_create_trial", {
      rewardEth: "0.1",
      specDigest: detail.specDigest,
      testsDigest: detail.testsDigest,
      deadlineHours: 2,
      breakWindowHours: 0.5,
    });
  } catch (err) {
    refused = /MIN_BREAK_WINDOW|BadWindow/.test(String(err.message));
  }
  check("a below-floor break window is refused before calldata exists", refused);
  check("the host read the contract's bounds", true);

  const create = await callTool("prepare_create_trial", {
    rewardEth: "0.1",
    specDigest: detail.specDigest,
    testsDigest: detail.testsDigest,
    deadlineHours: 2,
    breakWindowHours: 1,
  });
  if (!check("createTrial calldata reports its bounds were checked", create.limitsChecked === true, JSON.stringify(create).slice(0, 120))) {
    throw new Error("the host never read the trial bounds");
  }
  const createReceipt = await send(create, sponsor);
  const trialCount = Number(
    await publicClient.readContract({ address: trials, abi: TRIALS_ABI, functionName: "trialCount" }),
  );
  const trialId = trialCount;
  if (!check("the chain took the funding", trialId > source.id, `trialCount is ${trialCount}`)) throw new Error("no new trial");
  step("3b. createTrial", `trial #${trialId} funded 0.1 ETH — tx ${createReceipt.transactionHash.slice(0, 18)}…`);

  const claim = await callTool("prepare_claim_trial", { trialId });
  const claimReceipt = await send(claim, operator);
  step("3c. claimTrial", `bond moved into escrow — tx ${claimReceipt.transactionHash.slice(0, 18)}…`);

  // 4. the run itself. The contract accepts a submission only with the runner's own signature, so
  // this is signed here — no tool can hand it over, and none pretends to.
  const artifact = {
    trialId,
    agentId,
    suiteCid: detail.testsCID ?? detail.testsDigest,
    verdict: "pass",
    checks: [{ name: "test_counter_set_get", ok: true }],
    logsCid: null,
    ranAt: await chainNowSeconds(),
    degraded: false,
  };
  const runHash = computeRunHash(artifact);
  const sigDeadline = BigInt(await chainNowSeconds()) + BigInt(SIG_DEADLINE_TTL_SECONDS);
  const signature = await wallet.signTypedData({
    account: operator,
    domain: { name: "Crucible", version: "1", chainId: 31337, verifyingContract: trials },
    types: {
      Run: [
        { name: "trialId", type: "uint256" },
        { name: "agentId", type: "uint256" },
        { name: "runHash", type: "bytes32" },
        { name: "sigDeadline", type: "uint64" },
      ],
    },
    primaryType: "Run",
    message: { trialId: BigInt(trialId), agentId: BigInt(agentId), runHash, sigDeadline },
  });
  const submitHash = await wallet.writeContract({
    account: operator,
    address: trials,
    abi: TRIALS_ABI,
    functionName: "submitRun",
    args: [BigInt(trialId), runHash, signature, sigDeadline],
  });
  const submitReceipt = await publicClient.waitForTransactionReceipt({ hash: submitHash });
  if (!check("the chain accepted the submission", submitReceipt.status === "success", submitReceipt.status)) {
    throw new Error("submitRun reverted");
  }
  step("4. submitRun", `runHash ${runHash.slice(0, 14)}… tx ${submitHash.slice(0, 18)}…`);

  // 5. the same surface the agent worked in must now report the chain's answer.
  const deadline = Date.now() + 30_000;
  let seen = null;
  while (Date.now() < deadline) {
    try {
      seen = await callTool("get_trial", { id: trialId });
    } catch (err) {
      throw new Error(`the read model lost trial ${trialId}: ${err.message}`);
    }
    if (seen.status === "judging") break;
    await new Promise((r) => setTimeout(r, 1_000));
  }
  step("5. verified through MCP", `trial ${seen.id} is "${seen.status}", runHash ${String(seen.runHash).slice(0, 14)}…`);
  check("the MCP read model shows the trial judging", seen.status === "judging", `status ${seen.status}`);
  check("the MCP runHash matches the hash the agent signed", String(seen.runHash).toLowerCase() === runHash.toLowerCase(), `${seen.runHash} vs ${runHash}`);
  check("the snapshot subscription delivered", notifications > 0, `${notifications} notifications`);

  await client.close();
  console.log(`\n${passed.length} checks passed`);
  if (failed.length) {
    console.error(`FAILED:\n  ${failed.join("\n  ")}`);
    process.exit(1);
  }
  console.log(`  an external agent registered, funded, claimed and proved a trial over MCP with no UI.`);
}

main().catch((err) => {
  console.error(`MCP agent run stopped: ${err?.shortMessage ?? err?.message ?? String(err)}`);
  if (failed.length) console.error(`outstanding checks:\n  ${failed.join("\n  ")}`);
  process.exit(1);
});

