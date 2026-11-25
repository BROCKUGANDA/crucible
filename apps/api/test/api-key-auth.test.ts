/**
 * @file api-key-auth.test.ts — the API key as a credential.
 *
 * The claim under test: an organisation's key reads that organisation,
 * and nothing else. A key that reads another organisation would be a key
 * with the wrong grant, not a key with a missing check.
 *
 * The secret is verified with the SLOW hash (scrypt), so each
 * verification costs ~80 ms — which is why these tests are not many and
 * the proving is in the refusals rather than in a loop.
 */

import { describe, it, expect, beforeEach } from "vitest";
import { Hono } from "hono";
import {
  configureApiKeyStore,
  memoryApiKeyStore,
  newOrgApiKey,
  createApiKey,
  revokeApiKey,
  __resetApiKeyStoreForTests,
} from "@crucible/agent-security";
import { verifiedApiKey, presentedApiKey, ORG_READ_SCOPE } from "../src/api-key-auth.js";

const SECRET = "sk-auth-0123456789abcdef";
// Same PREFIX as the real secret, different body: the key is FOUND by the
// prefix and the SECRET must be what refuses it. A secret with a different
// prefix is never found at all, and would pass this test for the wrong
// reason.
const OTHER_SECRET = "sk-auth-9999999999999999";

describe("the API key as a credential", () => {
  beforeEach(async () => {
    configureApiKeyStore(memoryApiKeyStore());
    await __resetApiKeyStoreForTests();
  });

  it("accepts a valid key that carries the scope", async () => {
    const { key } = newOrgApiKey("k1", "org-1", "Reader", SECRET, [ORG_READ_SCOPE], "0xowner");
    await createApiKey({ key, plaintextSecret: SECRET });

    const app = new Hono();
    app.get("/", async (c) => {
      const result = await verifiedApiKey(c, [ORG_READ_SCOPE]);
      return c.json(result.ok ? { orgId: result.principal.orgId } : { code: result.code });
    });

    const res = await app.request("/", {
      headers: { authorization: `Bearer crux.${SECRET}` },
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ orgId: "org-1" });
  });

  it("refuses a key that does not carry the scope, and says which scope", async () => {
    const { key } = newOrgApiKey("k2", "org-1", "Narrow", SECRET, ["other:read"], "0xowner");
    await createApiKey({ key, plaintextSecret: SECRET });

    const app = new Hono();
    app.get("/", async (c) => {
      const result = await verifiedApiKey(c, [ORG_READ_SCOPE]);
      return c.json(result.ok ? { ok: true } : { code: result.code, reason: result.reason }, result.ok ? 200 : (result as { status: number }).status);
    });

    const res = await app.request("/", {
      headers: { authorization: `Bearer crux.${SECRET}` },
    });
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.code).toBe("wrong-scope");
    expect(body.reason).toContain(ORG_READ_SCOPE);
  });

  it("refuses a revoked key", async () => {
    const { key } = newOrgApiKey("k3", "org-1", "Reader", SECRET, [ORG_READ_SCOPE], "0xowner");
    await createApiKey({ key, plaintextSecret: SECRET });
    await revokeApiKey("k3", "org-1");

    const app = new Hono();
    app.get("/", async (c) => {
      const result = await verifiedApiKey(c, [ORG_READ_SCOPE]);
      return c.json(result.ok ? { ok: true } : { code: result.code }, result.ok ? 200 : (result as { status: number }).status);
    });

    const res = await app.request("/", {
      headers: { authorization: `Bearer crux.${SECRET}` },
    });
    expect(res.status).toBe(401);
    expect((await res.json()).code).toBe("revoked");
  });

  it("refuses a presentation with no key behind it", async () => {
    const app = new Hono();
    app.get("/", async (c) => {
      const result = await verifiedApiKey(c, [ORG_READ_SCOPE]);
      return c.json({ code: result.ok ? "ok" : result.code }, result.ok ? 200 : (result as { status: number }).status);
    });

    const none = await app.request("/");
    expect(none.status).toBe(401);
    expect((await none.json()).code).toBe("no-credential");

    const wrong = await app.request("/", {
      headers: { authorization: "Bearer some-other-token" },
    });
    expect(wrong.status).toBe(401);
  });

  it("reads the presentation only from the marked form", async () => {
    const app = new Hono();
    app.get("/", (c) => c.json({ presented: presentedApiKey(c) }));
    const marked = await app.request("/", {
      headers: { authorization: `Bearer crux.${SECRET}` },
    });
    expect(await marked.json()).toEqual({ presented: { secret: SECRET } });

    // Any other bearer token is another tool's token, not a key: a
    // presentation the platform does not recognise is absent, not invalid.
    const unmarked = await app.request("/", {
      headers: { authorization: "Bearer some-other-token" },
    });
    expect(await unmarked.json()).toEqual({ presented: null });
  });

  it("refuses a secret that is not the key's", async () => {
    const { key } = newOrgApiKey("k4", "org-1", "Reader", SECRET, [ORG_READ_SCOPE], "0xowner");
    await createApiKey({ key, plaintextSecret: SECRET });

    const app = new Hono();
    app.get("/", async (c) => {
      const result = await verifiedApiKey(c, [ORG_READ_SCOPE]);
      return c.json(result.ok ? { ok: true } : { code: result.code }, result.ok ? 200 : (result as { status: number }).status);
    });

    const res = await app.request("/", {
      headers: { authorization: `Bearer crux.${OTHER_SECRET}` },
    });
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect((await res.json()).ok).toBeUndefined();
  });
});
