import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { serve } from "@hono/node-server";
import type { AddressInfo } from "node:net";
import { emptyModel } from "@crucible/indexer";
import { createApp } from "../src/app.js";

/**
 * `/mcp` has a bucket of its own. This starts a real server because the limiter's identity is
 * the socket peer; `app.request` has no peer to key on.
 */
let server: ReturnType<typeof serve>;
let base = "";

beforeAll(async () => {
  const app = createApp(
    { getModel: () => emptyModel() },
    { mcpRateLimit: { limit: 2, windowMs: 60_000, burst: 0 } },
  );
  server = await new Promise<ReturnType<typeof serve>>((resolve) => {
    let handle: ReturnType<typeof serve>;
    handle = serve({ fetch: app.fetch, port: 0 }, () => resolve(handle));
  });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server?.close(() => resolve()));
});

describe("the dedicated MCP limiter", () => {
  it("refuses the third request while a read route stays available", async () => {
    const statuses: number[] = [];
    for (let i = 0; i < 3; i++) {
      const res = await fetch(`${base}/mcp`, {
        method: "GET",
        headers: { accept: "text/event-stream" },
      });
      statuses.push(res.status);
    }
    expect(statuses.slice(0, 2)).not.toContain(429);
    expect(statuses[2]).toBe(429);

    const refused = await fetch(`${base}/mcp`, {
      method: "GET",
      headers: { accept: "text/event-stream" },
    });
    expect(refused.status).toBe(429);
    expect(refused.headers.get("ratelimit-limit")).toBe("2");
    expect(Number(refused.headers.get("retry-after"))).toBeGreaterThan(0);

    const snapshot = await fetch(`${base}/snapshot`);
    expect(snapshot.status).toBe(200);
  });
});
