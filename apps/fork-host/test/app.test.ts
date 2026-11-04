import { describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";

/**
 * The handler surface of the fork provisioner. What is covered: the refusals
 * that need no chain and no anvil (bad body, bad id, stop of a fork that is
 * not running) and the honest 502 when the fork source itself is unreachable —
 * `provision` asks the source for its head before it spawns anything, so a
 * dead forkUrl fails fast and names the reason. What is deliberately not
 * covered: a successful provision, which needs a real anvil binary and a live
 * source chain. That path is exercised by hand against the local node; a test
 * that faked the spawn would assert a fiction, and a fake anvil here would be
 * the exact "mocked shape reporting empty" the repo forbids.
 */

function req(method: string, path: string, body?: unknown): Request {
  return new Request(`http://localhost${path}`, {
    method,
    headers: body === undefined ? undefined : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

describe("fork-host handler surface", () => {
  it("answers health with the count of running forks", async () => {
    const res = await createApp().request(req("GET", "/health"));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, running: 0 });
  });

  it("refuses a body that is not JSON", async () => {
    const res = await createApp().request(
      new Request("http://localhost/ghost", { method: "POST", body: "not json" }),
    );
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("invalid json");
  });

  it("refuses a trialId that is not a positive integer", async () => {
    const app = createApp();
    for (const bad of [0, -1, 1.5, "x", undefined]) {
      const res = await app.request(req("POST", "/ghost", { trialId: bad }));
      expect(res.status).toBe(400);
      expect((await res.json()).error).toBe("trialId must be positive integer");
    }
  });

  it("refuses to stop a fork that is not running", async () => {
    const res = await createApp().request(req("POST", "/ghost/999/stop"));
    expect(res.status).toBe(404);
    expect((await res.json()).error).toBe("not running");
  });

  it("reports a provision failure as a 502 that names the reason", async () => {
    // No anvil is needed to reach this refusal: the provisioner asks the fork
    // source for its head first, and nothing is listening on this port.
    const res = await createApp().request(
      req("POST", "/ghost", { trialId: 1, forkUrl: "http://127.0.0.1:1" }),
    );
    expect(res.status).toBe(502);
    const body = await res.json();
    expect(body.error).toMatch(/^provision failed:/);
  });
});
