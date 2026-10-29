import { describe, expect, it } from "vitest";
import { createFrenchyRoutes } from "../src/frenchy.js";

const WALLET = "0x" + "ab".repeat(20);

/** A fake OpenAI-compatible provider that records the request it was handed. */
function fakeBrain(reply = "The escrow page answers where your ETH is.") {
  const calls: { messages: { role: string; content: string }[] }[] = [];
  const fetchImpl = (async (_url: string, init: RequestInit) => {
    calls.push(JSON.parse(String(init.body)));
    return new Response(JSON.stringify({ choices: [{ message: { content: reply } }] }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as unknown as typeof fetch;
  return { calls, fetchImpl };
}

describe("Frenchy's brain context", () => {
  it("names the surfaces added after the first script", async () => {
    const brain = fakeBrain();
    const app = createFrenchyRoutes({
      llm: { apiKey: "test", model: "test-model", baseUrl: "https://llm.test/v1", fetchImpl: brain.fetchImpl },
    });

    const res = await app.request("/", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ prompt: "Where is my ETH?", history: [], wallet: { address: WALLET } }),
    });
    expect(res.status).toBe(200);
    expect((await res.json()).reply).toBe("The escrow page answers where your ETH is.");

    const request = brain.calls[0]!;
    const system = request.messages.find((m) => m.role === "system")!.content;
    const user = request.messages.find((m) => m.role === "user")!.content;
    expect(system).toContain("instead of repeating a greeting");
    // The surfaces moved from the per-request context into the prompt's site
    // index, which is where they belong: the index is a property of the site,
    // not of the moment. The property this test protects - that Frenchy is
    // told about them - is unchanged.
    expect(system).toContain("/verticals");
    expect(system).toContain("/escrow");
    // /mcp is an endpoint, not a page, so it is named in the per-request
    // context rather than in the site index - the index carries routes.
    expect(user).toContain("/mcp");
    expect(user).toContain("native ETH");
    expect(user).toContain(WALLET);
  });

  it("sends different prompts as different user messages", async () => {
    const brain = fakeBrain("Answer.");
    const app = createFrenchyRoutes({
      llm: { apiKey: "test", model: "test-model", baseUrl: "https://llm.test/v1", fetchImpl: brain.fetchImpl },
    });
    for (const prompt of ["What are the verticals?", "Where is my ETH?"]) {
      await app.request("/", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ prompt }),
      });
    }
    const users = brain.calls.map((c) => c.messages.find((m) => m.role === "user")!.content);
    expect(users[0]).not.toBe(users[1]);
    expect(users[0]).toContain("What are the verticals?");
    expect(users[1]).toContain("Where is my ETH?");
  });
});
