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
async function eventLogs(address, eventName) {
  const topics = await eventTopics();
  const toBlock = await rpc("eth_blockNumber");
  const logs = await rpc("eth_getLogs", [{ address, fromBlock: "0x0", toBlock, topics: [topics[eventName]] }]);
  return Array.isArray(logs) ? logs : [];
}

async function countLogs(address, eventName) {
  return (await eventLogs(address, eventName)).length;
}

/**
 * The two digests the contracts were built with, read from the generated library.
 *
 * Read from `SeedContent.sol` rather than recomputed here on purpose: that file is what the
 * Solidity scripts embed, so comparing the chain against it proves the *posted* value, not a
 * value this script invented. CI's `seed:check` is what ties that file to the bytes.
 */
async function committedDigests() {
  const src = await fs.readFile(`${ROOT}crucible-contracts/script/SeedContent.sol`, "utf8");
  const spec = src.match(/bytes32 constant SPEC_HASH = (0x[0-9a-f]{64});/)?.[1];
  const tests = src.match(/bytes32 constant TESTS_HASH = (0x[0-9a-f]{64});/)?.[1];
  if (!spec || !tests) throw new Error("SeedContent.sol does not carry both constants");
  return { spec, tests };
}

/**
 * Every trial on this chain was created with the content that is in the store.
 *
 * `TrialCreated`'s data is `abi.encode(specCID, testsCID, reward, bond, deadline, breakWindow)`,
 * so the first two words are the two commitments — no ABI needed to read them. This is the step
 * that makes the seeds checkable rather than intended: a trial whose hash answers to nothing is
 * a trial a skeptic cannot verify, and the chain would go on behaving as though it could.
 */
async function assertTrialsCarryPinnedContent(address) {
  const pinned = await committedDigests();
  const logs = await eventLogs(address, "TrialCreated");
  if (logs.length === 0) throw new Error("no TrialCreated logs to check the commitments against");
  const wrong = logs.filter((log) => {
    // `0x` + 64 hex each: the log data is `0x` followed by six packed words, so the prefix has to
    // be put back on the slices before comparing them to a digest that carries one.
    const words = [`0x${log.data.slice(2, 66)}`, `0x${log.data.slice(66, 130)}`];
    return words[0].toLowerCase() !== pinned.spec || words[1].toLowerCase() !== pinned.tests;
  });
  if (wrong.length > 0) {
    const first = `${wrong[0].data.slice(2, 66)} ${wrong[0].data.slice(66, 130)}`;
    throw new Error(
      `${wrong.length} of ${logs.length} trials commit to content that is not the pinned fixture ` +
        `(first: ${first}). A skeptic claiming one of these would be handed nothing to fetch.`,
    );
  }
  console.log("  %d trials, every one committing to the pinned spec and suite", logs.length);
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

/** What already answers on the RPC port, as a block number — or `null` when nothing does. */
async function chainHead() {
  try {
    const res = await fetch(RPC, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_blockNumber", params: [] }),
    });
    if (!res.ok) return null;
    const { result } = await res.json();
    return typeof result === "string" ? Number.parseInt(result, 16) : null;
  } catch {
    return null;
  }
}

async function main() {
  // Ask before spawning, not after: a second anvil cannot bind a port the first one holds, the
  // spawn below is `stdio: "ignore"`, and `rpcReady()` then answers ready against whatever node
  // is already living there. Measured 2026-10-25 — `npm run demo` on a box with a leftover anvil
  // replayed its whole loop onto 401 blocks of existing state and died at `Arena.submitRun` with
  // `Transaction Failure` and nothing naming the cause, while the identical script broadcast
  // clean on a fresh chain. A demo that runs on a contaminated chain is not a demo; it is a
  // measurement of someone's earlier session.
  const already = await chainHead();
  if (already !== null && already > 0) {
    throw new Error(
      `:8545 is already serving a chain at block ${already}. The demo deploys onto a chain it ` +
        `assumes is empty, and a second anvil cannot take the port — stop that node first.`,
    );
  }

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

  // The claim the demo makes is that a trial's spec and suite can be fetched and re-run. That is
  // only true if the bytes are in the store before the digest that names them goes on-chain, so
  // pin first and let the seeds post what the pinning reported. `--check` guards the same match
  // in CI; running the pin here is what makes this machine's store hold the bytes.
  console.log("▸ pinning the demo trial's spec and suite");
  await run(process.execPath, [join(ROOT, "scripts", "seed-content.mjs")], {
    cwd: ROOT,
    stdio: "inherit",
  });

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

  // The team ledger is deployed and driven here rather than in a test because every consumer of
  // it — the indexer's second Scribe, GET /teams, the page under it — was wired to a contract
  // nothing ever put on a chain. A demo chain without one can only answer `projected: false`,
  // which is a true statement about the host and a useless thing to show a visitor.
  console.log("▸ deploying the team ledger and running one team through it");
  const teams = await capture(
    FORGE,
    ["script", "script/Teams.s.sol:Teams", "--rpc-url", RPC, "--broadcast"],
    { cwd: `${ROOT}crucible-contracts`, env: { TRIALS_ADDRESS: trials } },
  );
  const teamLedger = teams.match(/TeamLedger (0x[0-9a-fA-F]{40})/)?.[1];
  if (!teamLedger) throw new Error(`could not parse the TeamLedger address:\n${teams}`);
  if (!(await hasCode(teamLedger))) {
    throw new Error(`the parsed TeamLedger holds no code on ${RPC}:\n${teamLedger}`);
  }
  console.log("✓ TeamLedger", teamLedger);

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
  await assertTrialsCarryPinnedContent(trials);

  // The compose seed publishes the addresses it deployed to a file, and the API
  // reads that file. The local demo publishes them the same way, so a script can
  // read where the contracts really are instead of parsing this output.
  const outPath = process.env.DEPLOYED_ENV_PATH;
  if (outPath) {
    await fs.writeFile(outPath, `TRIALS_ADDRESS=${trials}\nALLOY_ADDRESS=${alloy}\nTEAM_LEDGER_ADDRESS=${teamLedger}\n`);
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
