#!/usr/bin/env node
/**
 * One-command demo.
 *
 * Starts Anvil, deploys CrucibleTrials + AlloyRegistry, replays the whole loop
 * (sponsor → agent → skeptic → verdict), then leaves the node running so the web
 * app and API can be pointed at it.
 *
 * This is the 90-second stage fallback from the PRD: no RPC, no faucet, no wallet.
 */

import { spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import fs from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

const ROOT = new URL("..", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");

/**
 * Foundry is often installed at ~/.foundry/bin on Windows without joining PATH, so a
 * shell that can run `forge` interactively cannot hand that PATH to this child process.
 * Resolve the binary once, then use the resolved path for anvil and forge alike.
 */
function resolveFoundry(name) {
  if (spawnSync(name, ["--version"], { stdio: "ignore" }).status === 0) return name;
  const dir = process.env.FOUNDRY_BIN || join(homedir(), ".foundry", "bin");
  const candidates =
    process.platform === "win32" ? [join(dir, `${name}.exe`), join(dir, name)] : [join(dir, name)];
  return candidates.find((candidate) => existsSync(candidate)) ?? name;
}

const FORGE = resolveFoundry("forge");
const ANVIL = resolveFoundry("anvil");
const CAST = resolveFoundry("cast");
const ANVIL_PORT = 8545;
const RPC = `http://127.0.0.1:${ANVIL_PORT}`;
const ANVIL_KEY = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";

/** `--exit` builds the chain and then stops it: for CI and smoke tests, not for a laptop. */
const EXIT_AFTER = process.argv.includes("--exit") || process.env.CRUCIBLE_DEMO_EXIT === "1";

function run(cmd, args, opts = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, {
      cwd: opts.cwd ?? ROOT,
      env: { ...process.env, ...opts.env },
      shell: process.platform === "win32",
      stdio: opts.stdio ?? "inherit",
    });
    child.on("error", reject);
    child.on("close", (code) =>
      code === 0 ? resolve(undefined) : reject(new Error(`${cmd} exited ${code}`)),
    );
  });
}

function capture(cmd, args, opts = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, {
      cwd: opts.cwd ?? ROOT,
      env: { ...process.env, ...opts.env },
      shell: process.platform === "win32",
    });
    let out = "";
    child.stdout.on("data", (d) => (out += d.toString()));
    child.stderr.on("data", (d) => (out += d.toString()));
    child.on("error", reject);
    child.on("close", (code) =>
      code === 0 ? resolve(out) : reject(new Error(`${cmd} exited ${code}\n${out}`)),
    );
  });
}

async function rpc(method, params = []) {
  const res = await fetch(RPC, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  if (!res.ok) throw new Error(`${method} -> HTTP ${res.status}`);
  const body = await res.json();
  if (body.error) throw new Error(`${method} -> ${body.error.message}`);
  return body.result;
}

/** An address that holds code is a contract; one that does not is a hole in the demo. */
async function hasCode(address) {
  const code = await rpc("eth_getCode", [address, "latest"]);
  return typeof code === "string" && code.length > 2;
}

/**
 * How many times an event was emitted by an address, counted from the chain.
 *
 * The demo's own console output is not evidence: it is what the script believed it
 * did. The logs are what the chain says happened.
 */
async function countLogs(address, eventName) {
  const topics = await eventTopics();
  const toBlock = await rpc("eth_blockNumber");
  const logs = await rpc("eth_getLogs", [{ address, fromBlock: "0x0", toBlock, topics: [topics[eventName]] }]);
  return Array.isArray(logs) ? logs.length : 0;
}

/**
 * topic0 for every event of the escrow contract, read from its own compiled ABI.
 *
 * The signature is derived rather than typed in: a hand-written signature that drifts
 * from the source would silently count zero events, and a count of zero is exactly the
 * kind of wrong answer that reads like a truth.
 */
let topicCache = null;
async function eventTopics() {
  if (topicCache) return topicCache;
  const out = spawnSync(FORGE, ["inspect", "CrucibleTrials", "abi", "--json"], {
    cwd: `${ROOT}crucible-contracts`,
    encoding: "utf8",
  });
  if (out.status !== 0) throw new Error(`forge inspect failed:\n${out.stderr}`);
  const abi = JSON.parse(out.stdout.slice(out.stdout.indexOf("[")));
  topicCache = {};
  for (const item of abi) {
    if (item.type !== "event") continue;
    const signature = `${item.name}(${item.inputs.map((i) => i.type).join(",")})`;
    const keccaked = spawnSync(CAST, ["keccak", signature], { encoding: "utf8" });
    if (keccaked.status !== 0) throw new Error(`cast keccak failed for ${signature}`);
    topicCache[item.name] = keccaked.stdout.trim();
  }
  return topicCache;
}

async function rpcReady() {
  for (let i = 0; i < 40; i++) {
    try {
      const res = await fetch(RPC, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_chainId", params: [] }),
      });
      if (res.ok) return true;
    } catch {
      /* not up yet */
    }
    await sleep(250);
  }
  return false;
}

async function main() {
  console.log("▸ starting anvil on :%d", ANVIL_PORT);
  const anvil = spawn(ANVIL, ["--port", String(ANVIL_PORT), "--silent"], {
    shell: process.platform === "win32",
    stdio: "ignore",
    detached: false,
  });

  const shutdown = () => {
    if (!anvil.killed) anvil.kill();
  };
  process.on("exit", shutdown);
  process.on("SIGINT", () => {
    shutdown();
    process.exit(0);
  });

  if (!(await rpcReady())) {
    shutdown();
    throw new Error("anvil did not come up — check ~/.foundry/bin or set FOUNDRY_BIN");
  }
  console.log("✓ anvil ready");

  // The demo script deploys its OWN AlloyRegistry and CrucibleTrials and replays the
  // loop into them. Deploy.s.sol would deploy a second, empty pair, and printing
  // those addresses would point the API at a contract that has never settled
  // anything: the hall would open empty on a chain that just settled four trials.
  // So the addresses come from the script that actually carries the loop - the same
  // rule the compose seed follows.
  console.log("▸ deploying the contracts and replaying the loop");
  const demo = await capture(
    FORGE,
    ["script", "script/Demo.s.sol:Demo", "--rpc-url", RPC, "--broadcast"],
    { cwd: `${ROOT}crucible-contracts` },
  );
  const trials = demo.match(/CrucibleTrials (0x[0-9a-fA-F]{40})/)?.[1];
  const alloy = demo.match(/AlloyRegistry (0x[0-9a-fA-F]{40})/)?.[1];
  if (!trials || !alloy) throw new Error(`could not parse deployment addresses:\n${demo}`);
  if (!(await hasCode(trials)) || !(await hasCode(alloy))) {
    throw new Error(`the parsed addresses hold no code on ${RPC}:\n${trials}\n${alloy}`);
  }
  console.log(demo.trim());
  console.log("✓ CrucibleTrials", trials);
  console.log("✓ AlloyRegistry", alloy);

  // The loop leaves four settled trials: a hall worth reading, and nothing to do.
  // Two more make the chain something a visitor can act on — one open for claim,
  // one claimed and waiting for a run.
  console.log("▸ extending the chain with trials a visitor can act on");
  await run(
    FORGE,
    ["script", "script/Extend.s.sol:Extend", "--rpc-url", RPC, "--broadcast", "--private-key", ANVIL_KEY],
    { cwd: `${ROOT}crucible-contracts`, env: { TRIALS_ADDRESS: trials } },
  );

  // The claim the demo makes is that the hall is worth reading. Count it on the
  // chain rather than believing the script's own output.
  const created = await countLogs(trials, "TrialCreated");
  const settled = await countLogs(trials, "VerdictFinalized");
  console.log("");
  console.log("  %d trials on the chain, %d settled, %d still open for action", created, settled, created - settled);
  if (settled === 0) throw new Error("the demo settled nothing - the hall would open empty");
  if (created - settled === 0) throw new Error("nothing on the chain a visitor can act on");

  // The compose seed publishes the addresses it deployed to a file, and the API
  // reads that file. The local demo publishes them the same way, so a script can
  // read where the contracts really are instead of parsing this output.
  const outPath = process.env.DEPLOYED_ENV_PATH;
  if (outPath) {
    await fs.writeFile(outPath, `TRIALS_ADDRESS=${trials}\nALLOY_ADDRESS=${alloy}\n`);
    console.log("  published %s", outPath);
  }

  console.log("");
  console.log("  the forge is lit. anvil stays up on %s", RPC);
  console.log("");
  console.log("  api:  TRIALS_ADDRESS=%s ALLOY_ADDRESS=%s npm run api:dev", trials, alloy);
  console.log("  web:  NEXT_PUBLIC_API_URL=http://127.0.0.1:8787 npm run web:dev");
  console.log("");
  console.log("  press ctrl-c to stop anvil");

  // `--exit` is for a machine: CI and a smoke test need the chain to be built and
  // then gone, not a node left running under a job that will never end.
  if (EXIT_AFTER) {
    console.log("");
    console.log("  --exit given: stopping anvil");
    shutdown();
    process.exit(0);
  }
}

main().catch((err) => {
  console.error("demo failed:", err.message);
  process.exit(1);
});
