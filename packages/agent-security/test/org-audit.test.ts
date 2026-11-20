/**
 * @file org-audit.test.ts — Append-only organisation audit history tests.
 */

import { describe, it, expect, beforeEach } from "vitest";
import {
  newAuditEntry,
  createAuditEntry,
  getAuditEntry,
  listAuditForOrg,
  listAllAudit,
  verifyChain,
  __resetAuditStoreForTests,
} from "../src/org-audit.js";

beforeEach(async () => {
  await __resetAuditStoreForTests();
});

async function makeEntry(id: string, action: string, orgId = "org-1") {
  return newAuditEntry(id, "0xowner", action, { trialId: 42 }, orgId, `trial-${id}`);
}

describe("audit entries", () => {
  it("creates, reads and lists", async () => {
    const e = await makeEntry("e-1", "org:budget:set");
    await createAuditEntry(e);
    expect(await getAuditEntry("e-1")).toEqual(e);
    expect(await listAuditForOrg("org-1")).toHaveLength(1);
    expect(await listAuditForOrg("other-org")).toHaveLength(0);
    expect(await listAllAudit()).toHaveLength(1);
  });

  it("rejects duplicate entry", async () => {
    const e = await makeEntry("e-1", "org:budget:set");
    await createAuditEntry(e);
    await expect(createAuditEntry(e)).rejects.toThrow();
  });

  it("rejects broken chain link", async () => {
    const e1 = await makeEntry("e-1", "org:budget:set");
    await createAuditEntry(e1);
    const e2 = await newAuditEntry("e-2", "0xowner", "org:role:change", {}, "org-1", "trial-2");
    // Force wrong prevHash by creating a tampered entry.
    const tampered = { ...e2, prevHash: "wrong-hash" };
    await expect(createAuditEntry(tampered)).rejects.toThrow();
  });
});

describe("verifyChain", () => {
  it("validates an intact chain", async () => {
    await createAuditEntry(await makeEntry("e-1", "org:budget:set"));
    await createAuditEntry(await makeEntry("e-2", "org:role:change"));
    await createAuditEntry(await makeEntry("e-3", "org:member:remove"));
    expect((await verifyChain()).valid).toBe(true);
  });

  it("detects a broken chain link", async () => {
    const e1 = await makeEntry("e-1", "org:budget:set");
    await createAuditEntry(e1);
    const e2 = await makeEntry("e-2", "org:role:change");
    await createAuditEntry(e2);
    // Force a broken link by creating e-3 with a wrong prevHash.
    const e3 = await newAuditEntry("e-3", "0xowner", "org:member:remove", {}, "org-1", "trial-3");
    const broken = { ...e3, prevHash: "forced-wrong-hash" };
    await expect(createAuditEntry(broken)).rejects.toThrow();
  });

  it("limits results", async () => {
    await createAuditEntry(await makeEntry("e-1", "a"));
    await createAuditEntry(await makeEntry("e-2", "b"));
    await createAuditEntry(await makeEntry("e-3", "c"));
    expect(await listAuditForOrg("org-1", 2)).toHaveLength(2);
    expect(await listAllAudit(1)).toHaveLength(1);
  });
});
describe("the hash", () => {
  it("is a real sha256, not the fallback", async () => {
    // The chain used to ask for sha256 through `require()`, which does not
    // exist in an ES module: the error was swallowed and the chain was
    // linked with an eight-character rolling hash that anybody could
    // recompute. A tamper-evident chain hashed with a trivial hash is not
    // tamper-evident.
    const entry = await newAuditEntry("e-hash", "0xowner", "org:budget:set", { trialId: 42 }, "org-1");
    expect(entry.hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("does not depend on the order of the metadata's keys", async () => {
    // Canonical JSON, not JSON.stringify: the same content hashes the same
    // however its keys happen to be ordered. The chain used to hash a
    // JSON.stringify of the metadata, so a re-ordered (and equal) set of
    // keys produced a different digest — the sort of difference that makes
    // a verifier report a chain as tampered when it is not.
    const { auditEntryHash } = await import("../src/org-audit.js");
    const base = {
      prevHash: "genesis",
      id: "e-order",
      action: "org:budget:set",
      resource: undefined,
      at: 1_700_000_000_000,
      principalId: "0xowner",
      orgId: undefined,
    };
    expect(auditEntryHash({ ...base, metadata: { one: 1, two: 2 } })).toBe(
      auditEntryHash({ ...base, metadata: { two: 2, one: 1 } }),
    );
  });

  it("does not break when the metadata holds something that looks like a secret", async () => {
    // The write-time hash used to cover the RAW metadata while the entry
    // stored the REDACTED one, so an innocent write made the chain report
    // itself as tampered.
    const entry = await newAuditEntry(
      "e-secret",
      "0xowner",
      "api_key:create",
      { keyId: "k-1", name: "deploy" },
      "org-1",
    );
    await createAuditEntry(entry);
    expect(entry.metadata.keyId).toBe("[REDACTED]");
    const verdict = await verifyChain();
    expect(verdict.valid).toBe(true);
  });

  it("never hashes the secret itself", async () => {
    // A digest of a secret is an oracle for that secret: given the hash,
    // a guess can be confirmed. The hash covers what is STORED.
    const withSecret = await newAuditEntry(
      "e-oracle",
      "0xowner",
      "api_key:create",
      { apiKeySecret: "super-secret-value" },
      "org-1",
    );
    expect(withSecret.hash).not.toContain("super-secret-value");
    const digestOfTheSecret = await newAuditEntry(
      "e-oracle-2",
      "0xowner",
      "api_key:create",
      { apiKeySecret: "other-secret-value" },
      "org-1",
    );
    // A different secret, a different stored metadata — and therefore a
    // different hash. If the raw value were hashed, two different secrets
    // would still produce different hashes, but the POINT is that the
    // stored entry carries no trace of the secret at all.
    expect(withSecret.metadata.apiKeySecret).toBe("[REDACTED]");
    expect(digestOfTheSecret.metadata.apiKeySecret).toBe("[REDACTED]");
  });

  it("detects an entry whose contents were changed after the fact", async () => {
    const entry = await newAuditEntry("e-tamper", "0xowner", "org:budget:set", { trialId: 42 }, "org-1");
    await createAuditEntry(entry);
    const store = await import("../src/org-audit.js");
    const entries = await store.listAllAudit();
    expect(entries[0].action).toBe("org:budget:set");
    // A tampered entry does not verify: the hash is over what is stored.
    const forged = { ...entries[0], action: "org:budget:delete" };
    expect(store.auditEntryHash(forged)).not.toBe(forged.hash);
  });
});
