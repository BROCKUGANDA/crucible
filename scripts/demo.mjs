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

import { spawn } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";

const ROOT = new URL("..", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");
const ANVIL_PORT = 8545;
const RPC = `http://127.0.0.1:${ANVIL_PORT}`;
const ANVIL_KEY = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";

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
  const anvil = spawn("anvil", ["--port", String(ANVIL_PORT), "--silent"], {
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
    throw new Error("anvil did not come up — is Foundry on PATH?");
  }
  console.log("✓ anvil ready");

  console.log("▸ deploying contracts");
  const deploy = await capture("forge", ["script", "script/Deploy.s.sol:Deploy", "--rpc-url", RPC, "--broadcast", "--private-key", ANVIL_KEY], {
    cwd: `${ROOT}crucible-contracts`,
  });
  const trials = deploy.match(/CrucibleTrials (0x[0-9a-fA-F]{40})/)?.[1];
  const alloy = deploy.match(/AlloyRegistry (0x[0-9a-fA-F]{40})/)?.[1];
  if (!trials || !alloy) throw new Error(`could not parse deployment addresses:\n${deploy}`);
  console.log("✓ CrucibleTrials", trials);
  console.log("✓ AlloyRegistry", alloy);

  console.log("▸ replaying the loop");
  await run("forge", ["script", "script/Demo.s.sol:Demo", "--rpc-url", RPC, "--broadcast"], {
    cwd: `${ROOT}crucible-contracts`,
  });

  console.log("");
  console.log("  the forge is lit. anvil stays up on %s", RPC);
  console.log("");
  console.log("  api:  TRIALS_ADDRESS=%s ALLOY_ADDRESS=%s npm run api:dev", trials, alloy);
  console.log("  web:  NEXT_PUBLIC_API_URL=http://127.0.0.1:8787 npm run web:dev");
  console.log("");
  console.log("  press ctrl-c to stop anvil");
}

main().catch((err) => {
  console.error("demo failed:", err.message);
  process.exit(1);
});
