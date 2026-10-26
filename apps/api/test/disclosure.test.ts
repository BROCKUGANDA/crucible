import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { disclosedCids, disclosureFileIn } from "../src/disclosure.js";

/**
 * The row that says "suite not disclosed yet" is a claim about the world, and every part of
 * this reader has been wrong in production at least once: the API looked behind a misspelled
 * variable name, so it never saw the file the juror wrote, and every trial — including ones
 * already settled — said nothing had been disclosed.
 */
function writeDisclosure(dir: string, body: unknown): void {
  const file = disclosureFileIn(dir);
  mkdirSync(join(dir, "disclosure"), { recursive: true });
  writeFileSync(file, typeof body === "string" ? body : JSON.stringify(body), "utf8");
}

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), "crucible-disclosure-"));
}

const SPEC = "0xcfeedaa2b60a59b96750a7c369d93cc8d30b0bc9a27f4368111e9aab3297f921";
const TESTS = "0x76aca8ba4ca7935024ff4fda66b7cab4bd0b0bd8b730ed4dee507dbe575bd8aa";

describe("the disclosure reader", () => {
  it("separates the digest from the address that resolves to it", () => {
    const dir = tempDir();
    writeDisclosure(dir, {
      schemaVersion: 1,
      artifacts: {},
      specs: { [SPEC]: "bafySpec", [TESTS]: "bafyTests" },
    });
    const out = disclosedCids(dir, [{ id: 4, specDigest: SPEC, testsDigest: TESTS }], () => {
      throw new Error("no fault expected");
    });
    expect(out).toEqual([{ trialId: 4, specCID: "bafySpec", testsCID: "bafyTests" }]);
  });

  it("is silent when nothing has been announced", () => {
    const faults: string[] = [];
    const out = disclosedCids(tempDir(), [{ id: 1, specDigest: SPEC, testsDigest: TESTS }], (m) =>
      faults.push(m),
    );
    expect(out).toEqual([]);
    // An absent file is "nothing announced", not a failure: the first boot of a host has no
    // disclosure and that must not be reported as a broken one.
    expect(faults).toEqual([]);
  });

  it("reports a malformed disclosure instead of pretending nothing was announced", () => {
    const dir = tempDir();
    writeDisclosure(dir, "{ this is not json");
    const faults: string[] = [];
    const out = disclosedCids(dir, [{ id: 2, specDigest: SPEC, testsDigest: TESTS }], (m) =>
      faults.push(m),
    );
    expect(out).toEqual([]);
    expect(faults).toHaveLength(1);
    expect(faults[0]).toContain("disclosure.json");
  });

  it("matches digests whatever case the two sides use", () => {
    const dir = tempDir();
    writeDisclosure(dir, { schemaVersion: 1, artifacts: {}, specs: { [SPEC.toUpperCase().replace("0X", "0x")]: "bafySpec" } });
    // The chain hands the digest back lowercased by viem, and a producer that stopped
    // normalizing would otherwise silently miss every entry.
    const out = disclosedCids(dir, [{ id: 3, specDigest: SPEC, testsDigest: TESTS }], () => {
      throw new Error("no fault expected");
    });
    expect(out).toEqual([{ trialId: 3, specCID: "bafySpec", testsCID: undefined }]);
  });

  it("matches a trial digest that arrives in upper case too", () => {
    const dir = tempDir();
    writeDisclosure(dir, { schemaVersion: 1, artifacts: {}, specs: { [TESTS]: "bafyTests" } });
    const shouted = "0x" + TESTS.slice(2).toUpperCase();
    const out = disclosedCids(dir, [{ id: 9, specDigest: SPEC, testsDigest: shouted }], () => {
      throw new Error("no fault expected");
    });
    expect(out).toEqual([{ trialId: 9, specCID: undefined, testsCID: "bafyTests" }]);
  });

  it("keeps the half that was announced when only one was", () => {
    const dir = tempDir();
    writeDisclosure(dir, { schemaVersion: 1, artifacts: {}, specs: { [TESTS]: "bafyTests" } });
    const out = disclosedCids(dir, [{ id: 5, specDigest: SPEC, testsDigest: TESTS }], () => {
      throw new Error("no fault expected");
    });
    expect(out).toEqual([{ trialId: 5, specCID: undefined, testsCID: "bafyTests" }]);
  });

  it("ignores entries that are not addresses", () => {
    const dir = tempDir();
    writeDisclosure(dir, { schemaVersion: 1, artifacts: {}, specs: { [SPEC]: 42 } });
    const out = disclosedCids(dir, [{ id: 6, specDigest: SPEC, testsDigest: TESTS }], () => {
      throw new Error("no fault expected");
    });
    expect(out).toEqual([]);
  });

  it("does not invent a row for a trial nothing was announced for", () => {
    const dir = tempDir();
    writeDisclosure(dir, { schemaVersion: 1, artifacts: {}, specs: { [SPEC]: "bafySpec" } });
    const out = disclosedCids(
      dir,
      [
        { id: 7, specDigest: SPEC, testsDigest: TESTS },
        { id: 8, specDigest: "0x" + "11".repeat(32), testsDigest: "0x" + "22".repeat(32) },
      ],
      () => {
        throw new Error("no fault expected");
      },
    );
    expect(out.map((e) => e.trialId)).toEqual([7]);
  });

  it("reads the same path shape every writer writes", () => {
    // `DisclosureLog.open(join(dir, "disclosure"))` puts the file at `<dir>/disclosure/<name>`
    // on every producer: seed-content, verify-roundtrip, grade-arena and the juror seat.
    expect(disclosureFileIn("/content")).toBe(join("/content", "disclosure", "disclosure.json"));
  });
});
