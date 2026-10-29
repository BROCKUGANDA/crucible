import { describe, expect, it } from "vitest";
import {
  countNewApplications,
  ownerStateFrom,
  readAllocations,
  readApplications,
  type SponsorshipApplication,
} from "../src/lib/sponsorship.js";

/**
 * The owner's panel on the faucet page.
 *
 * The panel has one job that is easy to get wrong: telling "the queue is
 * empty" apart from "the host could not answer". A page that collapses the
 * two will one day tell an owner that nobody asked for sponsorship while a
 * wallet was standing at the counter.
 */

const APPLICATION: SponsorshipApplication = {
  id: 7,
  wallet: `0x${"22".repeat(20)}`,
  requestedEth: "0.05",
  grantedEth: "0.05",
  outcome: "granted",
  reason: null,
  at: 1_700_000_000_000,
};

describe("what the host's answer means", () => {
  it("reads 200 as the owner's own view", () => {
    expect(ownerStateFrom(200)).toBe("owner");
  });

  it("reads 403 as not the owner, not as a failure", () => {
    expect(ownerStateFrom(403)).toBe("not-owner");
  });

  it("reads anything else as the host failing to answer", () => {
    expect(ownerStateFrom(500)).toBe("unavailable");
    expect(ownerStateFrom(502)).toBe("unavailable");
    expect(ownerStateFrom(404)).toBe("unavailable");
  });
});

describe("reading the queue", () => {
  it("reads the applications out of the answer", () => {
    expect(readApplications({ applications: [APPLICATION] })).toEqual([APPLICATION]);
  });

  it("reads an empty queue as an empty queue, not as nothing", () => {
    expect(readApplications({ applications: [] })).toEqual([]);
  });

  it("refuses a body that is not a queue", () => {
    expect(readApplications(null)).toBeNull();
    expect(readApplications("nope")).toBeNull();
    expect(readApplications({})).toBeNull();
    expect(readApplications({ applications: "nope" })).toBeNull();
  });

  it("drops the entries that are not applications", () => {
    expect(readApplications({ applications: [APPLICATION, { wallet: "0x1" }, null] })).toEqual([
      APPLICATION,
    ]);
  });
});

describe("reading the ledger", () => {
  it("reads the allocations out of the answer", () => {
    const allocation = {
      wallet: `0x${"22".repeat(20)}`,
      requested: 0.05,
      granted: 0.05,
      at: "2026-10-29T12:00:00.000Z",
      ok: true,
    };
    expect(readAllocations({ allocations: [allocation] })).toEqual([allocation]);
  });

  it("refuses a body that is not a ledger", () => {
    expect(readAllocations({ allocations: "nope" })).toBeNull();
    expect(readAllocations(null)).toBeNull();
  });
});

describe("counting what arrived while the page was open", () => {
  it("counts nothing on the first read", () => {
    // A queue that was already full when the owner opened the page is
    // history, not a notification.
    expect(countNewApplications(null, [APPLICATION])).toEqual({ unseen: 0, seenUpTo: 7 });
  });

  it("counts nothing on a first read of an empty queue", () => {
    expect(countNewApplications(null, [])).toEqual({ unseen: 0, seenUpTo: 0 });
  });

  it("counts the first application that arrives after an empty queue", () => {
    // The owner opened the page to an empty queue and somebody applied. The
    // banner has to appear: "the highest id seen is zero" is not the same
    // fact as "the owner has been shown everything".
    expect(countNewApplications(0, [APPLICATION])).toEqual({ unseen: 7, seenUpTo: 7 });
  });

  it("counts what arrived after the owner last looked", () => {
    const arrived = { ...APPLICATION, id: 9 };
    expect(countNewApplications(7, [arrived])).toEqual({ unseen: 2, seenUpTo: 9 });
  });

  it("counts nothing when nothing arrived", () => {
    expect(countNewApplications(7, [APPLICATION])).toEqual({ unseen: 0, seenUpTo: 7 });
  });

  it("counts nothing on an empty queue", () => {
    expect(countNewApplications(7, [])).toEqual({ unseen: 0, seenUpTo: 7 });
  });
});
