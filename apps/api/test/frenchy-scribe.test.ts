import { describe, expect, it, vi } from "vitest";
import { createFrenchyRoutes } from "../src/frenchy.js";

describe("Frenchy scribe-url", () => {
  it("returns 503 when scribe is not configured", async () => {
    const app = createFrenchyRoutes({ llm: { apiKey: "t", model: "m", baseUrl: "https://llm.test/v1" } });
    const res = await app.request("/scribe-url");
    expect(res.status).toBe(503);
  });

  it("mints a signed URL when configured", async () => {
    const fetchImpl = vi.fn(async () =>
      new Response(JSON.stringify({ token: "tok123" }), { status: 200, headers: { "content-type": "application/json" } }),
    );
    const app = createFrenchyRoutes({
      llm: { apiKey: "t", model: "m", baseUrl: "https://llm.test/v1" },
      scribe: { apiKey: "sk", modelId: "scribe_v2_realtime", fetchImpl: fetchImpl as any },
    });
    const res = await app.request("/scribe-url");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.url).toContain("wss://");
    expect(body.url).toContain("token=tok123");
    expect(res.headers.get("cache-control")).toBe("no-store");
  });

  it("returns 502 when the token mint fails", async () => {
    const fetchImpl = vi.fn(async () => new Response("nope", { status: 401 }));
    const app = createFrenchyRoutes({
      llm: { apiKey: "t", model: "m", baseUrl: "https://llm.test/v1" },
      scribe: { apiKey: "sk", fetchImpl: fetchImpl as any },
    });
    const res = await app.request("/scribe-url");
    expect(res.status).toBe(502);
  });
});
