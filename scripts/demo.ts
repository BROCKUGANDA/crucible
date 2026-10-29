#!/usr/bin/env node
/**
 * Hackathon demo flow (Workstream D).
 *
 * Orchestrates the localnet demo: start Anvil → pin spec+suite → deploy via
 * forge (Demo.s.sol + Extend.s.sol) → verify on chain. Mirrors scripts/demo.mjs
 * in TypeScript so the two demos stay interchangeable; the eval-engine integration
 * (verdict hash → settle) is the next slice once the Solana/Anchor toolchain is
 * installed and the EVM `settleVerified` entry point exists.
 */

import { spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import fs from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

const ROOT = new URL("..", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");

function resolveFoundry(name: string): string {
  if (spawnSync(name, ["--version"], { stdio: "ignore" }).status === 0) return name;
  const dir = process.env.FOUNDRY_BIN || join(homedir(), ".foundry", "bin");
  const candidates =
    process.platform === "win32" ? [join(dir, `${name}.exe`), join(dir, name)] : [join(dir, name)];
  return candidates.find((candidate) => existsSync(candidate)) ?? name;
}

const FORGE = resolveFoundry("forge");
const ANVIL = resolveFoundry("anvil");
const ANVIL_PORT = 8545;
const RPC = `http://127.0.0.1:${ANVIL_PORT}`;
const ANVIL_KEY = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";

const EXIT_AFTER = process.argv.includes("--exit") || process.env.CRUCIBLE_DEMO_EXIT === "1";

function run(
  cmd: string,
  args: string[],
  opts: { cwd?: string; env?: Record<string, string>; stdio?: "inherit" | "ignore" | "pipe" } = {},
) {
  return new Promise<void>((resolve, reject) => {
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

function capture(cmd: string, args: string[], opts: { cwd?: string; env?: Record<string, string> } = {}) {
  return new Promise<string>((resolve, reject) => {
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

async function rpc(method: string, params: unknown[] = []): Promise<unknown> {
  const res = await fetch(RPC, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  if (!res.ok) throw new Error(`${method} -> HTTP ${res.status}`);
  const body = (await res.json()) as { error?: { message?: string }; result?: unknown };
  if (body.error) throw new Error(`${method} -> ${body.error.message}`);
  return body.result;
}

async function rpcReady(): Promise<boolean> {
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

  // ── 1. Pin the demo spec + suite ──────────────────────────────────────
  console.log("▸ pinning the demo trial's spec and suite");
  await run(process.execPath, [join(ROOT, "scripts", "seed-content.mjs")], {
    cwd: ROOT,
    stdio: "inherit",
  });

  // ── 2. Deploy + replay the loop ───────────────────────────────────────
  console.log("▸ deploying contracts and replaying the loop");
  const demo = await capture(FORGE, [
    "script", "script/Demo.s.sol:Demo", "--rpc-url", RPC, "--broadcast",
  ], { cwd: join(ROOT, "crucible-contracts") });
  const trials = demo.match(/CrucibleTrials (0x[0-9a-fA-F]{40})/)?.[1];
  const alloy = demo.match(/AlloyRegistry (0x[0-9a-fA-F]{40})/)?.[1];
  if (!trials || !alloy) throw new Error(`could not parse deployment addresses:\n${demo}`);
  console.log("✓ CrucibleTrials", trials);
  console.log("✓ AlloyRegistry", alloy);

  // ── 3. Extend with actable trials ─────────────────────────────────────
  console.log("▸ extending the chain with trials a visitor can act on");
  await run(FORGE, [
    "script", "script/Extend.s.sol:Extend", "--rpc-url", RPC, "--broadcast",
    "--private-key", ANVIL_KEY,
  ], { cwd: join(ROOT, "crucible-contracts"), env: { TRIALS_ADDRESS: trials } });

  // ── 4. Verify on chain ────────────────────────────────────────────────
  const created = await rpc("eth_getLogs", [
    {
      address: trials,
      fromBlock: "0x0",
      topics: [
        // topic0 for TrialCreated(uint256,address,bytes32,bytes32,uint256,uint256,uint64,uint64)
        "0x0000000000000000000000000000000000000000000000000000000000000000",
      ],
    },
  ]);
  const logs = Array.isArray(created) ? created : [];
  console.log("  %d TrialCreated logs on chain", logs.length);
  if (logs.length === 0) throw new Error("the demo settled nothing - the hall would open empty");

  // ── 5. Publish addresses ──────────────────────────────────────────────
  const outPath = process.env.DEPLOYED_ENV_PATH;
  if (outPath) {
    await fs.writeFile(outPath, `TRIALS_ADDRESS=${trials}\nALLOY_ADDRESS=${alloy}\n`);
    console.log("  published %s", outPath);
  }

  console.log("");
  console.log("  the forge is lit. anvil stays up on %s", RPC);
  console.log("  api:  TRIALS_ADDRESS=%s ALLOY_ADDRESS=%s npm run api:dev", trials, alloy);
  console.log("  web:  NEXT_PUBLIC_API_URL=http://127.0.0.1:8787 npm run web:dev");
  console.log("  press ctrl-c to stop anvil");

  if (EXIT_AFTER) {
    shutdown();
    process.exit(0);
  }
}

main().catch((err) => {
  console.error("demo failed:", err.message);
  process.exit(1);
});
