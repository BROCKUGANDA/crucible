/**
 * @file org-coi.test.ts — Conflict-of-interest register tests.
 *
 * A correlation signal alone is not collusion: the register creates a
 * reviewable risk signal, not a determination.
 */

import { describe, it, expect, beforeEach } from "vitest";
import {
  newCOIEntry,
  recordCOI,
  getCOIEntry,
  listCOIForPrincipal,
  listCOIForOrg,
  revokeCOI,
  conflictsBetween,
  reviewerIsConflicted,
  seatIsConflicted,
  __resetCOIStoreForTests,
} from "../src/org-coi.js";

beforeEach(async () => {
  await await __resetCOIStoreForTests();
});

describe("COI entries", () => {
  it("creates, reads and lists", async () => {
    const e = newCOIEntry(
      "coi-1",
      "0xalice",
      "employer",
      "Employed by Acme model lab",
      "0xalice",
      "org-1",
    );
    await recordCOI(e);
    expect(await getCOIEntry("coi-1")).toEqual(e);
    expect(await listCOIForPrincipal("0xalice")).toHaveLength(1);
    expect(await listCOIForOrg("org-1")).toHaveLength(1);
  });

  it("rejects duplicate entry", async () => {
    const e = newCOIEntry("coi-1", "0xalice", "employer", "x", "0xalice");
    await recordCOI(e);
    await expect(recordCOI(e)).rejects.toThrow();
  });

  it("rejects invalid entry", async () => {
    expect(() => newCOIEntry("", "0xalice", "employer", "x", "0xalice")).toThrow();
  });

  it("revokes entry", async () => {
    const e = newCOIEntry("coi-1", "0xalice", "employer", "x", "0xalice");
    await recordCOI(e);
    expect(await revokeCOI("coi-1")).toBe(true);
    expect((await getCOIEntry("coi-1"))?.active).toBe(false);
    expect(await revokeCOI("nope")).toBe(false);
  });
});

describe("conflictsBetween", () => {
  it("finds shared organisation interest", async () => {
    await recordCOI(newCOIEntry("c1", "0xalice", "employer", "Acme", "0xalice", "org-1"));
    await recordCOI(newCOIEntry("c2", "0xbob", "employer", "Acme", "0xbob", "org-1"));
    const shared = await conflictsBetween("0xalice", "0xbob");
    expect(shared).toHaveLength(1);
    expect(shared[0].type).toBe("employer");
  });

  it("returns empty when no shared interest", async () => {
    await recordCOI(newCOIEntry("c1", "0xalice", "employer", "Acme", "0xalice", "org-1"));
    await recordCOI(newCOIEntry("c2", "0xbob", "employer", "Globex", "0xbob", "org-2"));
    expect(await conflictsBetween("0xalice", "0xbob")).toHaveLength(0);
  });

  it("does not count revoked entries", async () => {
    await recordCOI(newCOIEntry("c1", "0xalice", "employer", "Acme", "0xalice", "org-1"));
    await recordCOI(newCOIEntry("c2", "0xbob", "employer", "Acme", "0xbob", "org-1"));
    await revokeCOI("c2");
    expect(await conflictsBetween("0xalice", "0xbob")).toHaveLength(0);
  });
});

describe("reviewerIsConflicted", () => {
  it("detects conflict between reviewer and submitter", async () => {
    await recordCOI(newCOIEntry("c1", "0xreviewer", "sponsor-affiliation", "co-sponsor", "0xreviewer", "org-1"));
    await recordCOI(newCOIEntry("c2", "0xsubmitter", "sponsor-affiliation", "co-sponsor", "0xsubmitter", "org-1"));
    const r = await reviewerIsConflicted("0xreviewer", "0xsubmitter");
    expect(r.conflicted).toBe(true);
    expect(r.entries).toHaveLength(1);
  });

  it("is not conflicted when no shared interest", async () => {
    await recordCOI(newCOIEntry("c1", "0xreviewer", "employer", "Acme", "0xreviewer", "org-1"));
    await recordCOI(newCOIEntry("c2", "0xsubmitter", "employer", "Globex", "0xsubmitter", "org-2"));
    const r = await reviewerIsConflicted("0xreviewer", "0xsubmitter");
    expect(r.conflicted).toBe(false);
    expect(r.entries).toHaveLength(0);
  });
});

describe("seatIsConflicted", () => {
  it("detects conflict against sponsor or agent", async () => {
    await recordCOI(newCOIEntry("c1", "0xseat", "sponsor-affiliation", "co-sponsor with trial sponsor", "0xseat", "org-1"));
    await recordCOI(newCOIEntry("c2", "0xsponsor", "sponsor-affiliation", "co-sponsor with trial sponsor", "0xsponsor", "org-1"));
    await recordCOI(newCOIEntry("c3", "0xagent", "employer", "different employer", "0xagent", "org-2"));
    const r = await seatIsConflicted("0xseat", "0xsponsor", "0xagent");
    expect(r.conflicted).toBe(true);
    expect(r.against).toContain("sponsor");
    expect(r.against).not.toContain("agent");
  });

  it("is not conflicted when neither sponsor nor agent shares an interest", async () => {
    await recordCOI(newCOIEntry("c1", "0xseat", "employer", "Acme", "0xseat", "org-1"));
    await recordCOI(newCOIEntry("c2", "0xsponsor", "employer", "Globex", "0xsponsor", "org-2"));
    await recordCOI(newCOIEntry("c3", "0xagent", "employer", "Umbrella", "0xagent", "org-3"));
    const r = await seatIsConflicted("0xseat", "0xsponsor", "0xagent");
    expect(r.conflicted).toBe(false);
    expect(r.against).toHaveLength(0);
  });
});