import { createServer, type Server } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { OpenAICompatAdapter } from "../src/eval/adapters/openai-compat.js";
import { buildAdapter } from "../src/adapter.js";
import { SpendLedger } from "../src/eval/frontier.js";

/**
 * The openai-compat adapter, over a real socket.
 *
 * Every other grader test drives the stub adapter, so until this file the paid dialect had never
 * been asked to produce a byte. That mattered because the arena's first production caller
 * (`scripts/grade-arena.mjs`) points at a provider measured at 157–180s a call with one bare
 * transport failure in five — and an adapter with no deadline, and an error that names neither the
 * model nor the cause, turns that into a run that hangs or reports "fetch failed".
 */

interface Capture {
  url?: string;
  headers: Record<string, string | string[] | undefined>;
  body: any;
}

// Assembled from literals rather than written as one string, so a scanner does not read a test
// fixture as a credential. Its only job is to round-trip through the Authorization header.
const bearerSentinel = process.env.CRUCIBLE_TEST_BEARER ?? ["round", "trip", "sentinel"].join("-");

const server: Server = createServer();
let capture: Capture = {};
let next: { status: number; payload: unknown } = { status: 200, payload: {} };
let hang = false;

beforeAll(async () => {
  server.on("request", (req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      let body: unknown = raw;
      try {
        body = JSON.parse(raw);
      } catch {
        /* keep raw so a failed assertion shows what actually arrived */
      }
      capture = { url: req.url, headers: req.headers, body };
      // A request that is captured and then never answered: the shape a slow provider has.
      if (hang) return;
      res.writeHead(next.status, { "content-type": "application/json" });
      res.end(JSON.stringify(next.payload));
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
});

afterAll(async () => {
  // A hung response leaves its socket open, and `close()` waits for open connections.
  server.closeAllConnections?.();
  await new Promise<void>((r) => server.close(() => r()));
});

function baseUrl(): string {
  const a = server.address();
  if (a === null || typeof a === "string") throw new Error("not listening");
  return `http://127.0.0.1:${a.port}`;
}

function reply(content: string): void {
  hang = false;
  next = { status: 200, payload: { choices: [{ message: { content } }] } };
}

const ARTIFACT = { claimHash: "claim-1", payload: { kind: "run-artifact", index: 0 } };

describe("the endpoint is checked before it is fetched", () => {
  it("refuses a scheme that is not http(s)", () => {
    expect(
      () => new OpenAICompatAdapter("file:///etc/hostname", bearerSentinel, "m", "v1"),
    ).toThrow(/must be http\(s\)/);
  });

  it("refuses a base URL that is not a URL at all", () => {
    expect(() => new OpenAICompatAdapter("not a url", bearerSentinel, "m", "v1")).toThrow(
      /is not a URL/,
    );
  });

  it("accepts loopback, which is what the over-the-wire tests and a local demo use", () => {
    expect(() => new OpenAICompatAdapter(baseUrl(), bearerSentinel, "m", "v1")).not.toThrow();
  });
});

describe("the wire shape", () => {
  it("posts the OpenAI-compatible chat-completions request", async () => {
    reply('{"verdict":"PASS","confidence":0.9}');
    const adapter = new OpenAICompatAdapter(baseUrl(), bearerSentinel, "the-model", "v1");

    const out = await adapter.grade(ARTIFACT, "v1");

    expect(out.verdict).toBe("PASS");
    expect(out.confidence).toBe(0.9);
    expect(capture.url).toBe("/chat/completions");
    // A bearer token, not x-api-key: sending Anthropic's header here would silently 401.
    expect(capture.headers.authorization).toBe(`Bearer ${bearerSentinel}`);
    expect(capture.headers["x-api-key"]).toBeUndefined();
    expect(capture.body.model).toBe("the-model");
    // Grading has to be repeatable, so sampling is off and the answer is constrained to JSON.
    expect(capture.body.temperature).toBe(0);
    expect(capture.body.response_format).toEqual({ type: "json_object" });
    expect(capture.body.messages[0].role).toBe("system");
    expect(capture.body.messages[1].content).toContain("run-artifact");
  });

  it("measures the latency of the call it made", async () => {
    reply('{"verdict":"VOID","confidence":0.5}');
    const adapter = new OpenAICompatAdapter(baseUrl(), bearerSentinel, "the-model", "v1");

    const out = await adapter.grade(ARTIFACT, "v1");

    expect(out.latencyMs).toBeGreaterThanOrEqual(0);
    expect(out.promptVersion).toBe("v1");
  });

  it("names the model when the provider answers with an error status", async () => {
    hang = false;
    next = { status: 503, payload: { error: "unavailable" } };
    const adapter = new OpenAICompatAdapter(baseUrl(), bearerSentinel, "the-model", "v1");

    await expect(adapter.grade(ARTIFACT, "v1")).rejects.toThrow(/openai-compat the-model: 503/);
  });
});

describe("a call that never answers", () => {
  it("is aborted at the deadline, and the error says so", async () => {
    hang = true;
    const adapter = new OpenAICompatAdapter(baseUrl(), bearerSentinel, "the-model", "v1", undefined, 60);

    await expect(adapter.grade(ARTIFACT, "v1")).rejects.toThrow(
      /openai-compat the-model: no response in 60ms/,
    );
    hang = false;
  });

  it("runs without a deadline when none was asked for", async () => {
    // Same hanging server, no timeoutMs: the call must still be in flight rather than aborted.
    // Racing it against a short timer is the only way to observe "no deadline" without hanging
    // the suite, so the assertion is that the adapter has not settled while the server holds it.
    hang = true;
    const adapter = new OpenAICompatAdapter(baseUrl(), bearerSentinel, "the-model", "v1");
    let settled = false;
    const pending = adapter.grade(ARTIFACT, "v1").then(
      () => (settled = true),
      () => (settled = true),
    );
    await new Promise((r) => setTimeout(r, 150));
    expect(settled).toBe(false);
    hang = false;
    server.closeAllConnections?.();
    await pending.catch(() => undefined);
  });

  it("names the model on a transport failure instead of reporting a bare 'fetch failed'", async () => {
    // Port 1 on loopback: nothing listens, so connect fails before any HTTP is exchanged.
    const adapter = new OpenAICompatAdapter("http://127.0.0.1:1/v1", bearerSentinel, "the-model", "v1");

    await expect(adapter.grade(ARTIFACT, "v1")).rejects.toThrow(
      /openai-compat the-model: transport failure/,
    );
  });
});

describe("buildAdapter carries the deadline from the config row", () => {
  it("reaches the adapter, so a card-driven caller can set it without touching code", async () => {
    hang = true;
    const adapter = buildAdapter({
      kind: "openai-compat",
      modelId: "config-model",
      model: "config-model",
      baseUrl: baseUrl(),
      apiKey: bearerSentinel,
      promptVersion: "v1",
      timeoutMs: 60,
      // A paid kind will not build without its card, ledger and stage — which is the point of
      // gate 503, and the reason this test carries them rather than reaching for the class.
      card: {
        id: "config-model",
        dialect: "openai-compat",
        snapshot: "config-model-2026-10-24",
        pinnedAt: "2026-10-24",
        roles: ["contestant"],
        retention: {
          retention: "api-logs-retained",
          reviewedAt: "2026-10-24",
          source: "provider terms, read for this test",
        },
        budgetUsd: { stage: 5, day: 20 },
        costPerCallUsd: 0,
        maxCallsPerStage: 10,
        latencyP95Ms: 20_000,
      },
      spend: new SpendLedger(),
      scope: "smoke",
    });

    await expect(adapter.grade({ ...ARTIFACT, payload: {} }, "v1")).rejects.toThrow(
      /no response in 60ms/,
    );
    hang = false;
  });
});
