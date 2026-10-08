import { describe, expect, it } from "vitest";
import { createServer } from "node:http";
import { foundry } from "viem/chains";
import { Scribe } from "../src/scribe.js";

/**
 * The breaker in `sync()`, driven through a real client against a node that refuses every
 * request. What is being proved is that the node stops being asked: a tailer whose dependency is
 * down spends four `withBackoff` retries per tick forever, and at a 2s poll that is 180 doomed
 * calls a minute to a machine that is not answering.
 *
 * The refusal is a JSON-RPC error whose text is not retryable, so each attempt is one request.
 * A retryable failure would still be caught by these assertions, just with more requests behind
 * each tick.
 */

const ADDRESS = "0x9fe46736679d2d9a65f0992f2272de9f3c7fa6e0" as `0x${string}`;

async function refusingNode(): Promise<{ url: string; hits: () => number; close: () => void }> {
  let requests = 0;
  const refusal = (id: number) => ({
    jsonrpc: "2.0",
    id,
    error: { code: -32000, message: "unavailable: node is pruning this range" },
  });
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      requests += 1;
      const parsed = JSON.parse(body || "{}") as { id: number } | { id: number }[];
      // Answer in the shape it was asked in: a batched request gets an array, a lone request
      // gets an object, or the client never reads the refusal as a refusal.
      const payload = Array.isArray(parsed) ? parsed.map((p) => refusal(p.id)) : refusal(parsed.id);
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(payload));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as { port: number };
  return {
    url: `http://127.0.0.1:${port}`,
    hits: () => requests,
    close: () => server.close(),
  };
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

async function until(pred: () => boolean, withinMs = 5_000): Promise<void> {
  const started = Date.now();
  while (!pred()) {
    if (Date.now() - started > withinMs) throw new Error("condition never held");
    await sleep(2);
  }
}

describe("the RPC breaker on the sync path", () => {
  it("stops asking the node once three failed passes trip it", async () => {
    const node = await refusingNode();
    const reported: { kind: string; detail: string }[] = [];
    const scribe = new Scribe({
      trialsAddress: ADDRESS,
      alloyAddress: ADDRESS,
      chain: foundry,
      rpcUrl: node.url,
      pollMs: 1,
      onError: (kind, detail) => reported.push({ kind, detail }),
    });

    expect(scribe.breaker.name).toBe("scribe.rpc");
    expect(scribe.breaker.status().state).toBe("closed");

    await expect(scribe.sync()).rejects.toThrow(/pruning|fetch/i);
    expect(scribe.breaker.status().failures).toBe(1);
    await expect(scribe.sync()).rejects.toThrow();
    await expect(scribe.sync()).rejects.toThrow();

    expect(scribe.breaker.status().state).toBe("open");
    const askedBefore = node.hits();

    // Refused passes cost the node nothing — the breaker answers before the client is reached.
    await expect(scribe.sync()).rejects.toThrow(/is tripped/);
    expect(node.hits()).toBe(askedBefore);

    node.close();
  });

  it("tails a dead node without either stalling or hammering it", async () => {
    const node = await refusingNode();
    const scribe = new Scribe({
      trialsAddress: ADDRESS,
      alloyAddress: ADDRESS,
      chain: foundry,
      rpcUrl: node.url,
      pollMs: 1,
      onError: () => {},
    });

    void scribe.watch();
    await until(() => scribe.breaker.status().state === "open");
    const askedWhileOpen = node.hits();
    const failuresWhileOpen = scribe.breaker.status().failures;

    // Dozens of ticks later the cursor has not moved, the breaker is still open, and the node
    // has been asked exactly as many times as it took to trip.
    await sleep(120);
    expect(node.hits()).toBe(askedWhileOpen);
    expect(scribe.status.indexedTo).toBe(0n);
    expect(scribe.breaker.status().state).toBe("open");
    expect(scribe.breaker.status().retryAfterMs).toBeGreaterThan(0);
    expect(scribe.breaker.status().failures).toBe(failuresWhileOpen);

    scribe.stop();
    node.close();
  });
});
