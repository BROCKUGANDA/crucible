/**
 * @file org-api-key-pg.test.ts — the organisation API keys, in PostgreSQL.
 *
 * The claim under test: **a revocation survives a restart.** That is the
 * defect that made the keys durable in the first place — a revocation in
 * process memory is undone by the next restart, and the moment a
 * credential is most likely to be tried again is right after somebody
 * rotated it in a hurry.
 *
 * The store is exercised against a REAL PostgreSQL. A fake cannot tell
 * you that a column does not exist, that a NOT NULL constraint refuses a
 * write the in-memory path accepts happily, or that the uniqueness of the
 * PREFIX is enforced by anything at all.
 *
 * The suite is SKIPPED when there is no database to talk to, and says so
 * rather than passing quietly.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { getPool, runMigrations } from "../src/database.js";
import {
  configureApiKeyStore,
  apiKeyStoreKind,
  currentApiKeyStore,
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
import { pgApiKeyStore } from "../src/org-api-key-pg.js";

const DATABASE_URL = process.env.DATABASE_URL?.trim();
const suite = DATABASE_URL ? describe : describe.skip;

const ORG = "org-pg-1";
const OTHER_ORG = "org-pg-2";
const SECRET = "sk-pg-0123456789abcdef";

suite("org-api-key-pg", () => {
  beforeAll(async () => {
    await runMigrations();
    configureApiKeyStore(pgApiKeyStore());
  });

  afterAll(async () => {
    await getPool().end().catch(() => {});
  });

  beforeEach(async () => {
    await __resetApiKeyStoreForTests();
  });

  it("is the postgresql store once configured", () => {
    expect(apiKeyStoreKind()).toBe("postgresql");
  });

  it("keeps a key across a fresh read of the table", async () => {
    const { key } = newOrgApiKey("key-pg-1", ORG, "Reader", SECRET, ["org:read"], "0xowner");
    await createApiKey({ key, plaintextSecret: SECRET });
    const stored = await getApiKey("key-pg-1");
    expect(stored?.name).toBe("Reader");
    expect(stored?.scopes).toEqual(["org:read"]);
  });

  it("A REVOCATION SURVIVES A RESTART — the revoked key does not come back", async () => {
    const { key } = newOrgApiKey("key-pg-2", ORG, "Reader", SECRET, ["org:read"], "0xowner");
    await createApiKey({ key, plaintextSecret: SECRET });
    expect(await revokeApiKey("key-pg-2", ORG)).toBe(true);

    // A brand new store object over the same database: this is what a
    // restart looks like from here.
    const restarted = pgApiKeyStore();
    const stored = await restarted.get("key-pg-2");
    expect(stored?.revokedAt, "the revocation did not survive").toBeGreaterThan(0);

    // And the key does not authenticate.
    const attempt = await validateApiKey(key.prefix, SECRET, ["org:read"]);
    expect(attempt.valid).toBe(false);
    expect(attempt.code).toBe("revoked");
  });

  it("a revoked key never authenticates, even in the same process", async () => {
    const { key } = newOrgApiKey("key-pg-3", ORG, "Reader", SECRET, ["org:read"], "0xowner");
    await createApiKey({ key, plaintextSecret: SECRET });
    expect((await validateApiKey(key.prefix, SECRET, ["org:read"])).valid).toBe(true);
    await revokeApiKey("key-pg-3", ORG);
    expect((await validateApiKey(key.prefix, SECRET, ["org:read"])).valid).toBe(false);
  });

  it("refuses a duplicate id and a colliding prefix, in the same words", async () => {
    const { key } = newOrgApiKey("key-pg-4", ORG, "Reader", SECRET, ["org:read"], "0xowner");
    await createApiKey({ key, plaintextSecret: SECRET });
    await expect(createApiKey({ key, plaintextSecret: SECRET })).rejects.toThrow(
      /key already exists: key-pg-4/,
    );

    const colliding = SECRET.slice(0, 8) + "0123456789";
    const { key: other } = newOrgApiKey("key-pg-5", ORG, "Other", colliding, ["org:read"], "0xowner");
    await expect(createApiKey({ key: other, plaintextSecret: colliding })).rejects.toThrow(
      /prefix collision/,
    );
  });

  it("scopes a revocation to its organisation", async () => {
    const { key } = newOrgApiKey("key-pg-6", ORG, "Reader", SECRET, ["org:read"], "0xowner");
    await createApiKey({ key, plaintextSecret: SECRET });
    // Another organisation may not revoke it.
    expect(await revokeApiKey("key-pg-6", OTHER_ORG)).toBe(false);
    expect((await getApiKey("key-pg-6"))?.revokedAt).toBeUndefined();
    // And the right one may.
    expect(await revokeApiKey("key-pg-6", ORG)).toBe(true);
  });

  it("a second revocation has nothing to revoke", async () => {
    const { key } = newOrgApiKey("key-pg-13", ORG, "Reader", SECRET, ["org:read"], "0xowner");
    await createApiKey({ key, plaintextSecret: SECRET });
    expect(await revokeApiKey("key-pg-13", ORG)).toBe(true);
    // The second call changed nothing, so it says so — the same in both
    // stores.
    expect(await revokeApiKey("key-pg-13", ORG)).toBe(false);
  });

  it("an expired key does not authenticate", async () => {
    const { key } = newOrgApiKey("key-pg-14", ORG, "Reader", SECRET, ["org:read"], "0xowner", undefined, Date.now() - 1000);
    await createApiKey({ key, plaintextSecret: SECRET });
    const attempt = await validateApiKey(key.prefix, SECRET, ["org:read"]);
    expect(attempt.valid).toBe(false);
    expect(attempt.code).toBe("expired");
  });

  it("lists an organisation's keys, and only that organisation's", async () => {
    const { key } = newOrgApiKey("key-pg-7", ORG, "Reader", SECRET, ["org:read"], "0xowner");
    await createApiKey({ key, plaintextSecret: SECRET });
    expect(await listApiKeysForOrg(ORG)).toHaveLength(1);
    expect(await listApiKeysForOrg(OTHER_ORG)).toHaveLength(0);
  });

  it("finds a key by its prefix and verifies the secret", async () => {
    const { key } = newOrgApiKey("key-pg-8", ORG, "Reader", SECRET, ["org:read"], "0xowner");
    await createApiKey({ key, plaintextSecret: SECRET });
    const found = await getApiKeyByPrefix(key.prefix);
    expect(found?.id).toBe("key-pg-8");
    expect((await validateApiKey(key.prefix, SECRET, ["org:read"])).valid).toBe(true);
    expect((await validateApiKey(key.prefix, "sk-wrong-0123456789abcdef", ["org:read"])).valid).toBe(
      false,
    );
  });

  it("records the use of a key", async () => {
    const { key } = newOrgApiKey("key-pg-9", ORG, "Reader", SECRET, ["org:read"], "0xowner");
    await createApiKey({ key, plaintextSecret: SECRET });
    await validateApiKey(key.prefix, SECRET, ["org:read"]);
    const stored = await getApiKey("key-pg-9");
    expect(stored?.lastUsedAt).toBeGreaterThan(0);
  });

  it("rotates a key: the old secret stops working and the new one starts", async () => {
    const { key } = newOrgApiKey("key-pg-10", ORG, "Reader", SECRET, ["org:read"], "0xowner");
    await createApiKey({ key, plaintextSecret: SECRET });
    const newSecret = "sk-rotated-0123456789ab";
    const rotated = await rotateApiKey("key-pg-10", newSecret);
    expect(rotated?.plaintextSecret).toBe(newSecret);

    expect((await validateApiKey(key.prefix, SECRET, ["org:read"])).valid).toBe(false);
    expect((await validateApiKey("sk-rotat", newSecret, ["org:read"])).valid).toBe(true);
  });

  it("refuses a scope the key was not granted", async () => {
    const { key } = newOrgApiKey("key-pg-11", ORG, "Reader", SECRET, ["org:read"], "0xowner");
    await createApiKey({ key, plaintextSecret: SECRET });
    const attempt = await validateApiKey(key.prefix, SECRET, ["org:read", "org:manage"]);
    expect(attempt.valid).toBe(false);
    expect(attempt.code).toBe("wrong-scope");
  });

  it("stores the hash, never the secret", async () => {
    const { key } = newOrgApiKey("key-pg-12", ORG, "Reader", SECRET, ["org:read"], "0xowner");
    await createApiKey({ key, plaintextSecret: SECRET });
    const pool = getPool();
    const rows = await pool.query("SELECT * FROM org_api_keys WHERE id = 'key-pg-12'");
    const stored = rows.rows[0] as Record<string, unknown>;
    expect(String(stored.secret_hash)).not.toContain(SECRET);
    // And the hash is a slow, salted one — not a fast digest.
    expect(String(stored.secret_hash).startsWith("scrypt$")).toBe(true);
  });

  it("the store in use is the one the API configured", () => {
    expect(currentApiKeyStore().kind).toBe("postgresql");
  });
});
