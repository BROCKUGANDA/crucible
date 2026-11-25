/**
 * @file api-key-routes.test.ts — the organisation's own key on the
 * organisation's own routes.
 *
 * The claim under test: an organisation's key reads that organisation and
 * nothing else, and it writes nothing.
 *
 * The write half matters as much as the read half: a key that could
 * create or revoke a credential would be a key that could change who
 * holds credentials — and a key that could write at all is a key that
 * could, one permission change later, move money (ADR-0006).
 */

process.env.AUTH_ALLOW_DEV_SECRET = "1";
process.env.AUTH_ORIGIN = "http://localhost:3000";

import { describe, it, expect, beforeEach } from "vitest";
import { createApp } from "../src/app.js";
import { emptyModel } from "@crucible/indexer";
import {
  createOrganisation,
  newOrganisation,
  newOrgApiKey,
  createApiKey,
  configureApiKeyStore,
  memoryApiKeyStore,
  __resetApiKeyStoreForTests,
  __resetStoreForTests,
} from "@crucible/agent-security";

const ORG = "org-key-1";
const OTHER_ORG = "org-key-2";
const SECRET = "sk-route-0123456789abcdef";
const OWNER = "0x" + "12".repeat(20);

function app() {
  return createApp({ model: emptyModel() });
}

describe("the API key on the organisation routes", () => {
  beforeEach(async () => {
    configureApiKeyStore(memoryApiKeyStore());
    await __resetApiKeyStoreForTests();
    __resetStoreForTests();
    createOrganisation(newOrganisation(ORG, "Key Org", "key-org", OWNER));
    createOrganisation(newOrganisation(OTHER_ORG, "Other Org", "other-org", OWNER));
  });

  it("reads its OWN organisation", async () => {
    const { key } = newOrgApiKey("rk1", ORG, "Reader", SECRET, ["org:read"], OWNER);
    await createApiKey({ key, plaintextSecret: SECRET });

    const res = await app().request(`/orgs/${ORG}`, {
      headers: { authorization: `Bearer crux.${SECRET}` },
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.organisation.id).toBe(ORG);
  });

  it("refuses ANOTHER organisation — a key that reads another org would be a key with the wrong grant", async () => {
    const { key } = newOrgApiKey("rk2", ORG, "Reader", SECRET, ["org:read"], OWNER);
    await createApiKey({ key, plaintextSecret: SECRET });

    const res = await app().request(`/orgs/${OTHER_ORG}`, {
      headers: { authorization: `Bearer crux.${SECRET}` },
    });
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.code).toBe("key-not-for-this-org");
  });

  it("cannot WRITE — creating a key needs a wallet signature", async () => {
    const { key } = newOrgApiKey("rk3", ORG, "Reader", SECRET, ["org:read"], OWNER);
    await createApiKey({ key, plaintextSecret: SECRET });

    const res = await app().request(`/orgs/${ORG}/api-keys`, {
      method: "POST",
      headers: {
        authorization: `Bearer crux.${SECRET}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ keyId: "rk4", name: "Another" }),
    });
    expect(res.status).toBe(401);
    expect((await res.json()).code).toBe("no-credential");
  });

  it("lists its own organisation's keys, without the hashes", async () => {
    const { key } = newOrgApiKey("rk5", ORG, "Reader", SECRET, ["org:read"], OWNER);
    await createApiKey({ key, plaintextSecret: SECRET });

    const res = await app().request(`/orgs/${ORG}/api-keys`, {
      headers: { authorization: `Bearer crux.${SECRET}` },
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.apiKeys).toHaveLength(1);
    expect(body.apiKeys[0].id).toBe("rk5");
    // The hash never leaves: a reader gets the name and the prefix.
    expect(body.apiKeys[0].secretHash).toBeUndefined();
  });

  it("refuses a request with no credential at all", async () => {
    const res = await app().request(`/orgs/${ORG}`);
    expect(res.status).toBe(401);
    expect((await res.json()).code).toBe("no-credential");
  });
});
