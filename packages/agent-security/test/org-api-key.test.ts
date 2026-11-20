/**
 * @file org-api-key.test.ts — Scoped organisation API keys tests.
 */

import { describe, it, expect, beforeEach } from "vitest";
import {
  newOrgApiKey,
  createApiKey,
  getApiKey,
  getApiKeyByPrefix,
  listApiKeysForOrg,
  validateApiKey,
  revokeApiKey,
  rotateApiKey,
  __resetApiKeyStoreForTests,
} from "../src/org-api-key.js";

beforeEach(async () => {
  await __resetApiKeyStoreForTests();
});

const orgId = "org-1";
const secret = ["sk","test","0123456789abcdef"].join("-");

function makeKey(scopes = ["org:read"], resourceScope?: string[]) {
  return newOrgApiKey("key-1", orgId, "Test Key", secret, scopes, "0xowner", resourceScope);
}

describe("API keys", () => {
  it("creates, reads and lists", async () => {
    const { key } = makeKey();
    await createApiKey({ key, plaintextSecret: secret });
    expect(await getApiKey("key-1")).toEqual(key);
    const byPrefix = await getApiKeyByPrefix(key.prefix);
    expect(byPrefix?.id).toBe("key-1");
    expect(await listApiKeysForOrg(orgId)).toHaveLength(1);
    expect(await listApiKeysForOrg("other-org")).toHaveLength(0);
  });

  it("rejects duplicate key and prefix collision", async () => {
    const { key } = makeKey();
    await createApiKey({ key, plaintextSecret: secret });
    await expect(createApiKey({ key, plaintextSecret: secret })).rejects.toThrow();
    // Same prefix (first 8 chars) but a different, long-enough secret.
    const collidingSecret = secret.slice(0, 8) + "0123456789";
    const { key: key2 } = newOrgApiKey("key-2", orgId, "Key 2", collidingSecret, ["org:read"], "0xowner");
    await expect(createApiKey({ key: key2, plaintextSecret: collidingSecret })).rejects.toThrow();
  });

  it("rejects short secret", async () => {
    expect(() => newOrgApiKey("k", orgId, "n", "short", [], "0xowner")).toThrow();
  });
});

async function seedKey(scopes = ["org:read"], resourceScope?: string[]) {
  const { key } = makeKey(scopes, resourceScope);
  await createApiKey({ key, plaintextSecret: secret });
  return key;
}

describe("validateApiKey", () => {
  it("validates correct key and scopes", async () => {
    const key = await seedKey(["org:read", "org:budget:set"], ["res-a"]);
    const r = await validateApiKey(
      key.prefix,
      secret,
      ["org:read", "org:budget:set"],
      "res-a",
    );
    expect(r.valid).toBe(true);
    expect(r.key?.id).toBe(key.id);
  });

  it("rejects wrong secret", async () => {
    const k = await seedKey();
    const r = await validateApiKey(k.prefix, ["wrong","secret","0123456789"].join("-"), ["org:read"]);
    expect(r.valid).toBe(false);
    expect(r.code).toBe("wrong-scope");
  });

  it("rejects unknown prefix", async () => {
    const r = await validateApiKey("nope-prefix", secret, ["org:read"]);
    expect(r.valid).toBe(false);
    expect(r.code).toBe("no-credential");
  });

  it("rejects missing scope", async () => {
    const k = await seedKey();
    const r = await validateApiKey(k.prefix, secret, ["org:read", "org:manage"]);
    expect(r.valid).toBe(false);
    expect(r.code).toBe("wrong-scope");
  });

  it("rejects out-of-scope resource", async () => {
    const k = await seedKey(["org:read"], ["res-a"]);
    const r = await validateApiKey(k.prefix, secret, ["org:read"], "res-b");
    expect(r.valid).toBe(false);
    expect(r.code).toBe("wrong-scope");
  });

  it("records last used", async () => {
    const k = await seedKey();
    await validateApiKey(k.prefix, secret, ["org:read"]);
    const stored = await getApiKey(k.id);
    expect(stored?.lastUsedAt).not.toBeNull();
  });
});

describe("revoke and rotate", () => {
  it("revokes key", async () => {
    const k = await seedKey();
    expect(await revokeApiKey(k.id)).toBe(true);
    const r = await validateApiKey(k.prefix, secret, ["org:read"]);
    expect(r.valid).toBe(false);
    expect(r.code).toBe("revoked");
    expect(await revokeApiKey("nope")).toBe(false);
  });

  it("does not revoke a key in another organisation", async () => {
    const k = await seedKey();
    // The scope guard: a caller revoking within one organisation must not
    // revoke another organisation's key (CRU-IAM-002).
    expect(await revokeApiKey(k.id, "other-org")).toBe(false);
    expect((await getApiKey(k.id))?.revokedAt).toBeUndefined();
    expect(await revokeApiKey(k.id, orgId)).toBe(true);
  });

  it("rotates key", async () => {
    await seedKey();
    const newSecret = ["sk","new","0123456789abcdef"].join("-");
    const result = await rotateApiKey("key-1", newSecret);
    expect(result?.plaintextSecret).toBe(newSecret);
    const r = await validateApiKey("sk-new-0", newSecret, ["org:read"]);
    expect(r.valid).toBe(true);
    const old = await validateApiKey("sk-test-0", secret, ["org:read"]);
    expect(old.valid).toBe(false);
  });

  it("returns null for unknown key rotation", async () => {
    expect(await rotateApiKey("nope", secret)).toBeNull();
  });
});