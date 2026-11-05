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

beforeEach(() => {
  __resetApiKeyStoreForTests();
});

const orgId = "org-1";
const secret = "sk-test-0123456789abcdef";

function makeKey(scopes = ["org:read"], resourceScope?: string[]) {
  return newOrgApiKey("key-1", orgId, "Test Key", secret, scopes, "0xowner", resourceScope);
}

describe("API keys", () => {
  it("creates, reads and lists", () => {
    const { key } = makeKey();
    createApiKey({ key, plaintextSecret: secret });
    expect(getApiKey("key-1")).toEqual(key);
    const byPrefix = getApiKeyByPrefix(key.prefix);
    expect(byPrefix?.id).toBe("key-1");
    expect(listApiKeysForOrg(orgId)).toHaveLength(1);
    expect(listApiKeysForOrg("other-org")).toHaveLength(0);
  });

  it("rejects duplicate key and prefix collision", () => {
    const { key } = makeKey();
    createApiKey({ key, plaintextSecret: secret });
    expect(() => createApiKey({ key, plaintextSecret: secret })).toThrow();
    // Same prefix (first 8 chars) but a different, long-enough secret.
    const collidingSecret = secret.slice(0, 8) + "0123456789";
    const { key: key2 } = newOrgApiKey("key-2", orgId, "Key 2", collidingSecret, ["org:read"], "0xowner");
    expect(() => createApiKey({ key: key2, plaintextSecret: collidingSecret })).toThrow();
  });

  it("rejects short secret", () => {
    expect(() => newOrgApiKey("k", orgId, "n", "short", [], "0xowner")).toThrow();
  });
});

function seedKey(scopes = ["org:read"], resourceScope?: string[]) {
  const { key } = makeKey(scopes, resourceScope);
  createApiKey({ key, plaintextSecret: secret });
  return key;
}

describe("validateApiKey", () => {
  it("validates correct key and scopes", () => {
    const key = seedKey(["org:read", "org:budget:set"], ["res-a"]);
    const r = validateApiKey(
      key.prefix,
      secret,
      ["org:read", "org:budget:set"],
      "res-a",
    );
    expect(r.valid).toBe(true);
    expect(r.key?.id).toBe(key.id);
  });

  it("rejects wrong secret", () => {
    const k = seedKey();
    const r = validateApiKey(k.prefix, "wrong-secret-0123456789", ["org:read"]);
    expect(r.valid).toBe(false);
    expect(r.code).toBe("wrong-scope");
  });

  it("rejects unknown prefix", () => {
    const r = validateApiKey("nope-prefix", secret, ["org:read"]);
    expect(r.valid).toBe(false);
    expect(r.code).toBe("no-credential");
  });

  it("rejects missing scope", () => {
    const k = seedKey();
    const r = validateApiKey(k.prefix, secret, ["org:read", "org:manage"]);
    expect(r.valid).toBe(false);
    expect(r.code).toBe("wrong-scope");
  });

  it("rejects out-of-scope resource", () => {
    const k = seedKey(["org:read"], ["res-a"]);
    const r = validateApiKey(k.prefix, secret, ["org:read"], "res-b");
    expect(r.valid).toBe(false);
    expect(r.code).toBe("wrong-scope");
  });

  it("records last used", () => {
    const k = seedKey();
    validateApiKey(k.prefix, secret, ["org:read"]);
    const stored = getApiKey(k.id);
    expect(stored?.lastUsedAt).not.toBeNull();
  });
});

describe("revoke and rotate", () => {
  it("revokes key", () => {
    const k = seedKey();
    expect(revokeApiKey(k.id)).toBe(true);
    const r = validateApiKey(k.prefix, secret, ["org:read"]);
    expect(r.valid).toBe(false);
    expect(r.code).toBe("revoked");
    expect(revokeApiKey("nope")).toBe(false);
  });

  it("rotates key", () => {
    seedKey();
    const newSecret = "sk-new-0123456789abcdef";
    const result = rotateApiKey("key-1", newSecret);
    expect(result?.plaintextSecret).toBe(newSecret);
    const r = validateApiKey("sk-new-0", newSecret, ["org:read"]);
    expect(r.valid).toBe(true);
    const old = validateApiKey("sk-test-0", secret, ["org:read"]);
    expect(old.valid).toBe(false);
  });

  it("returns null for unknown key rotation", () => {
    expect(rotateApiKey("nope", secret)).toBeNull();
  });
});