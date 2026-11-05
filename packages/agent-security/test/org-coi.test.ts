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

beforeEach(() => {
  __resetCOIStoreForTests();
});

describe("COI entries", () => {
  it("creates, reads and lists", () => {
    const e = newCOIEntry(
      "coi-1",
      "0xalice",
      "employer",
      "Employed by Acme model lab",
      "0xalice",
      "org-1",
    );
    recordCOI(e);
    expect(getCOIEntry("coi-1")).toEqual(e);
    expect(listCOIForPrincipal("0xalice")).toHaveLength(1);
    expect(listCOIForOrg("org-1")).toHaveLength(1);
  });

  it("rejects duplicate entry", () => {
    const e = newCOIEntry("coi-1", "0xalice", "employer", "x", "0xalice");
    recordCOI(e);
    expect(() => recordCOI(e)).toThrow();
  });

  it("rejects invalid entry", () => {
    expect(() => newCOIEntry("", "0xalice", "employer", "x", "0xalice")).toThrow();
  });

  it("revokes entry", () => {
    const e = newCOIEntry("coi-1", "0xalice", "employer", "x", "0xalice");
    recordCOI(e);
    expect(revokeCOI("coi-1")).toBe(true);
    expect(getCOIEntry("coi-1")?.active).toBe(false);
    expect(revokeCOI("nope")).toBe(false);
  });
});

describe("conflictsBetween", () => {
  it("finds shared organisation interest", () => {
    recordCOI(newCOIEntry("c1", "0xalice", "employer", "Acme", "0xalice", "org-1"));
    recordCOI(newCOIEntry("c2", "0xbob", "employer", "Acme", "0xbob", "org-1"));
    const shared = conflictsBetween("0xalice", "0xbob");
    expect(shared).toHaveLength(1);
    expect(shared[0].type).toBe("employer");
  });

  it("returns empty when no shared interest", () => {
    recordCOI(newCOIEntry("c1", "0xalice", "employer", "Acme", "0xalice", "org-1"));
    recordCOI(newCOIEntry("c2", "0xbob", "employer", "Globex", "0xbob", "org-2"));
    expect(conflictsBetween("0xalice", "0xbob")).toHaveLength(0);
  });

  it("does not count revoked entries", () => {
    recordCOI(newCOIEntry("c1", "0xalice", "employer", "Acme", "0xalice", "org-1"));
    recordCOI(newCOIEntry("c2", "0xbob", "employer", "Acme", "0xbob", "org-1"));
    revokeCOI("c2");
    expect(conflictsBetween("0xalice", "0xbob")).toHaveLength(0);
  });
});

describe("reviewerIsConflicted", () => {
  it("detects conflict between reviewer and submitter", () => {
    recordCOI(newCOIEntry("c1", "0xreviewer", "sponsor-affiliation", "co-sponsor", "0xreviewer", "org-1"));
    recordCOI(newCOIEntry("c2", "0xsubmitter", "sponsor-affiliation", "co-sponsor", "0xsubmitter", "org-1"));
    const r = reviewerIsConflicted("0xreviewer", "0xsubmitter");
    expect(r.conflicted).toBe(true);
    expect(r.entries).toHaveLength(1);
  });

  it("is not conflicted when no shared interest", () => {
    recordCOI(newCOIEntry("c1", "0xreviewer", "employer", "Acme", "0xreviewer", "org-1"));
    recordCOI(newCOIEntry("c2", "0xsubmitter", "employer", "Globex", "0xsubmitter", "org-2"));
    const r = reviewerIsConflicted("0xreviewer", "0xsubmitter");
    expect(r.conflicted).toBe(false);
    expect(r.entries).toHaveLength(0);
  });
});

describe("seatIsConflicted", () => {
  it("detects conflict against sponsor or agent", () => {
    recordCOI(newCOIEntry("c1", "0xseat", "sponsor-affiliation", "co-sponsor with trial sponsor", "0xseat", "org-1"));
    recordCOI(newCOIEntry("c2", "0xsponsor", "sponsor-affiliation", "co-sponsor with trial sponsor", "0xsponsor", "org-1"));
    recordCOI(newCOIEntry("c3", "0xagent", "employer", "different employer", "0xagent", "org-2"));
    const r = seatIsConflicted("0xseat", "0xsponsor", "0xagent");
    expect(r.conflicted).toBe(true);
    expect(r.against).toContain("sponsor");
    expect(r.against).not.toContain("agent");
  });

  it("is not conflicted when neither sponsor nor agent shares an interest", () => {
    recordCOI(newCOIEntry("c1", "0xseat", "employer", "Acme", "0xseat", "org-1"));
    recordCOI(newCOIEntry("c2", "0xsponsor", "employer", "Globex", "0xsponsor", "org-2"));
    recordCOI(newCOIEntry("c3", "0xagent", "employer", "Umbrella", "0xagent", "org-3"));
    const r = seatIsConflicted("0xseat", "0xsponsor", "0xagent");
    expect(r.conflicted).toBe(false);
    expect(r.against).toHaveLength(0);
  });
});