import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createPublicClient, http } from "viem";
import { foundry } from "viem/chains";

/**
 * The successful provision path, against a REAL anvil.
 *
 * The handler refusals are covered in app.test.ts without a chain; this file
 * covers the one path a fake would only pretend to test: POST /ghost actually
 * spawns an anvil forked from a live source, the fork answers with the source's
 * history and its own funded accounts, and stop ends it. The provisioner's
 * promise — a play-money fork a ghost run can execute against — is only proven
 * by a fork that actually serves blocks.
 *
 * Skipped loudly when anvil is not installed: the suite needs the toolchain,
 * and a skip that does not say so is a green that proves nothing.
 */

const foundryBin = join(process.env.USERPROFILE ?? process.env.HOME ?? "", ".foundry", "bin");
function foundryTool(name: string): string | null {
  const exe = process.platform === "win32" ? `${name}.exe` : name;
  for (const candidate of [exe, join(foundryBin, exe)]) {
    try {
      const probe = spawnSync(candidate, ["--version"], { encoding: "utf8", timeout: 30_000 });
      if (probe.status === 0) return candidate;
    } catch {
      /* try the next candidate */
    }
  }
  return null;
}

const SOURCE_PORT = 8549;
const sourceRpc = `http://127.0.0.1:${SOURCE_PORT}`;
let anvilBin: string;
let source: ChildProcess | null = null;

beforeAll(async () => {
  anvilBin = foundryTool("anvil") ?? "";
  if (!anvilBin) return;
  source = spawn(anvilBin, ["--port", String(SOURCE_PORT), "--silent"], {
    detached: true,
    stdio: "ignore",
  });
  source.unref?.();
  const deadline = Date.now() + 30_000;
  for (;;) {
    try {
      const c = createPublicClient({ chain: foundry, transport: http(sourceRpc) });
      await c.getBlockNumber();
      return;
    } catch {
      if (Date.now() > deadline) throw new Error("source anvil did not start");
      await new Promise((r) => setTimeout(r, 300));
    }
  }
}, 60_000);

afterAll(() => {
  source?.pid && process.kill(source.pid, "SIGKILL");
});

function waitUntil(url: string, timeoutMs = 40_000) {
  const deadline = Date.now() + timeoutMs;
  return new Promise<void>((resolve, reject) => {
    const tick = async () => {
      try {
        const c = createPublicClient({ chain: foundry, transport: http(url) });
        await c.getBlockNumber();
        resolve();
      } catch {
        if (Date.now() > deadline) reject(new Error(`fork at ${url} never answered`));
        else setTimeout(tick, 400);
      }
    };
    tick();
  });
}

describe("the provisioner against a real anvil", () => {
  it("spawns a fork that serves the source's blocks and funded accounts, and stop ends it", async () => {
    if (!anvilBin) {
      console.warn("skipping: anvil is not installed — the live provision path cannot run here");
      return;
    }
    // ANVIL_BIN must be set before app.js is imported: the module reads it once.
    process.env.ANVIL_BIN = anvilBin;
    process.env.FORK_HOST_PORT = "8792";
    const { createApp } = await import("../src/app.js");
    const app = createApp();

    const sourceHead = await createPublicClient({ chain: foundry, transport: http(sourceRpc) }).getBlockNumber();

    const res = await app.request("http://localhost/ghost", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ trialId: 1, forkUrl: sourceRpc }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      rpcUrl: string;
      forkBlock: number;
      chainId: number;
      accounts: Array<{ address: string; balanceEth: string }>;
    };

    // The fork reports the source's height at fork time and the local chain id.
    expect(body.forkBlock).toBe(Number(sourceHead));
    expect(body.chainId).toBe(31337);
    // Anvil's dev accounts, prefunded on the fork: the play money the ghost run spends.
    expect(body.accounts.length).toBe(3);
    expect(Number(body.accounts[0]!.balanceEth)).toBeGreaterThan(1000);

    // The fork is a real node: it serves blocks and the source's account balances.
    const fork = createPublicClient({ chain: foundry, transport: http(body.rpcUrl) });
    await waitUntil(body.rpcUrl);
    expect(await fork.getBlockNumber()).toBeGreaterThanOrEqual(Number(sourceHead));
    expect(
      await fork.getBalance({ address: "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266" }),
    ).toBeGreaterThan(10n ** 21n);

    // Health counts the running fork.
    const health = await app.request("http://localhost/health");
    expect(((await health.json()) as { running: number }).running).toBe(1);

    // Stop ends it: the fork's RPC stops answering.
    const stop = await app.request("http://localhost/ghost/1/stop", { method: "POST" });
    expect(stop.status).toBe(200);
    await expect(waitUntil(body.rpcUrl, 15_000)).rejects.toThrow();
    const after = await app.request("http://localhost/health");
    expect(((await after.json()) as { running: number }).running).toBe(0);
  }, 120_000);
});
