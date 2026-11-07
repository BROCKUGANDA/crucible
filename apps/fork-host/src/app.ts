import { spawn, type ChildProcess } from "node:child_process";
import { Hono } from "hono";
import { createPublicClient, http } from "viem";
import { foundry } from "viem/chains";

/**
 * The Harena app, split from the entry so the handler surface is testable:
 * `serve()` at module load cannot be imported by a test without taking the
 * port. The spawn path itself is not covered here — see test/app.test.ts for
 * what is, and what deliberately is not.
 */

export const port = Number(process.env.FORK_HOST_PORT ?? 8790);
export const host = process.env.FORK_HOST_HOST ?? "127.0.0.1";
export const anvilBin = process.env.ANVIL_BIN ?? "anvil";

export interface ProvisionRequest { trialId: number; forkUrl?: string; }
export interface FundedAccount { address: `0x${string}`; privateKey: `0x${string}`; balanceEth: string; }
export interface ProvisionResult { rpcUrl: string; forkBlock: number; chainId: number; accounts: FundedAccount[]; }
export interface RunningFork { proc: ChildProcess; port: number; forkBlock: number; forkUrl: string; }

// The Anvil well-known dev keys, on a chain where ETH is test ETH worth nothing.
const DEV_ACCOUNTS: { address: `0x${string}`; privateKey: `0x${string}` }[] = [
  { address: "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266", privateKey: "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80" },
  { address: "0x70997970C51812dc3A010C7d01b50e0d17dc79C8", privateKey: "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d" },
  { address: "0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC", privateKey: "0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a" },
];

export function createApp() {
  const running = new Map<number, RunningFork>();

  // A monotonic cursor, not `8546 + running.size`: two provisions in flight would
  // both compute the same port and one anvil would lose the bind and die quietly.
  // Wrapping keeps a long-lived host from walking off the top of the port range.
  let portCursor = 0;
  function nextPort(): number {
    return 8546 + (portCursor++ % 2000);
  }

  async function provision(req: ProvisionRequest): Promise<ProvisionResult> {
    const forkUrl = req.forkUrl ?? process.env.FORK_SOURCE_URL ?? "http://127.0.0.1:8545";
    const p = nextPort();
    const srcClient = createPublicClient({ chain: foundry, transport: http(forkUrl) });
    const forkBlock = Number(await srcClient.getBlockNumber());
    const child = spawn(anvilBin, ["--host", "0.0.0.0", "--port", String(p), "--fork-url", forkUrl, "--fork-block-number", String(forkBlock), "--silent"], { stdio: "ignore" });
    // Without a listener, a spawn failure (no anvil on PATH, a bad binary) surfaces as
    // an unhandled 'error' event and can take the whole host down. With one, it becomes
    // a 502 — which is what a provisioner that cannot provision should say.
    let spawnError: Error | undefined;
    child.on("error", (err) => {
      spawnError = err;
    });
    await new Promise<void>((resolve, reject) => {
      const deadline = Date.now() + 30_000;
      const tick = async () => {
        if (spawnError) return reject(new Error(`anvil could not start: ${spawnError.message}`));
        if (Date.now() > deadline) return reject(new Error("anvil did not start"));
        try {
          const c = createPublicClient({ chain: foundry, transport: http(`http://127.0.0.1:${p}`) });
          await c.getBlockNumber();
          resolve();
        } catch {
          setTimeout(tick, 500);
        }
      };
      tick();
    });
    const rpcUrl = `http://127.0.0.1:${p}`;
    running.set(req.trialId, { proc: child, port: p, forkBlock, forkUrl });
    const client = createPublicClient({ chain: foundry, transport: http(rpcUrl) });
    const accounts: FundedAccount[] = [];
    for (const a of DEV_ACCOUNTS) {
      const bal = await client.getBalance({ address: a.address });
      accounts.push({ address: a.address, privateKey: a.privateKey, balanceEth: (Number(bal) / 1e18).toString() });
    }
    const chainId = await client.getChainId();
    return { rpcUrl, forkBlock, chainId, accounts };
  }

  const app = new Hono();
  app.get("/health", (c) => c.json({ ok: true, running: running.size }));

  app.post("/ghost", async (c) => {
    let body: unknown;
    try { body = await c.req.json(); } catch { return c.json({ error: "invalid json" }, 400); }
    if (typeof body !== "object" || body === null) return c.json({ error: "invalid body" }, 400);
    const obj = body as Record<string, unknown>;
    const trialId = Number(obj.trialId);
    if (!Number.isSafeInteger(trialId) || trialId <= 0) return c.json({ error: "trialId must be positive integer" }, 400);
    const forkUrl = typeof obj.forkUrl === "string" ? obj.forkUrl : undefined;
    try {
      const res = await provision({ trialId, forkUrl });
      return c.json(res);
    } catch (err) {
      return c.json({ error: `provision failed: ${(err as Error).message}` }, 502);
    }
  });

  app.post("/ghost/:id/stop", async (c) => {
    const trialId = Number(c.req.param("id"));
    const r = running.get(trialId);
    if (!r) return c.json({ error: "not running" }, 404);
    // SIGTERM lets anvil shut down gracefully, and a graceful shutdown still answers
    // requests for a few hundred milliseconds — long enough for a caller that polls
    // straight after this 200 to see a fork that "stop" claims has ended. The response
    // therefore waits for the exit (SIGKILL after a grace period if the graceful path
    // stalls), so the 200 means the RPC is actually gone.
    r.proc.kill();
    await new Promise<void>((resolve) => {
      if (r.proc.exitCode !== null || r.proc.signalCode) return resolve();
      const killTimer = setTimeout(() => {
        r.proc.kill("SIGKILL");
      }, 5_000);
      r.proc.once("exit", () => {
        clearTimeout(killTimer);
        resolve();
      });
    });
    running.delete(trialId);
    return c.json({ ok: true });
  });

  return app;
}
