import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { DisclosureError, DisclosureLog } from "../src/disclosure.js";

/**
 * The disclosure is the only thing connecting a chain digest to bytes that exist, so its
 * failure modes matter more than its happy path: a reader that treats a corrupt file as
 * "nothing announced yet" would abstain from every dispute for a reason nothing reports.
 */

async function dir(): Promise<string> {
  return mkdtemp(path.join(tmpdir(), "crucible-disclosure-"));
}

describe("DisclosureLog", () => {
  it("round-trips an announcement through a second handle", async () => {
    const d = await dir();
    const a = await DisclosureLog.open(d);
    await a.announceArtifact("0xAaAA".toLowerCase(), "bafy-test");
    await a.announceSpec("0xdead", "bafy-spec");

    const b = await DisclosureLog.open(d);
    expect(b.artifactCidFor("0xaaaa")).toBe("bafy-test");
    expect(b.specCidFor("0xDEAD")).toBe("bafy-spec");
  });

  it("looks up without regard to the digest's hex case", async () => {
    const d = await dir();
    const log = await DisclosureLog.open(d);
    await log.announceArtifact("0xAbCd", "bafy-x");
    expect(log.artifactCidFor("0xabcd")).toBe("bafy-x");
    expect(log.artifactCidFor("0xABCD")).toBe("bafy-x");
  });

  it("is idempotent and does not rewrite the file for the same claim", async () => {
    const d = await dir();
    const log = await DisclosureLog.open(d);
    await log.announceArtifact("0x1", "bafy-a");
    const first = await readFile(path.join(d, "disclosure.json"), "utf8");
    await log.announceArtifact("0x1", "bafy-a");
    expect(await readFile(path.join(d, "disclosure.json"), "utf8")).toBe(first);
  });

  it("refuses a corrupt file rather than silently starting empty", async () => {
    const d = await dir();
    await writeFile(path.join(d, "disclosure.json"), "{ not json", "utf8");
    await expect(DisclosureLog.open(d)).rejects.toThrow(DisclosureError);
  });

  it("refuses a disclosure from a schema it does not understand", async () => {
    const d = await dir();
    await writeFile(
      path.join(d, "disclosure.json"),
      JSON.stringify({ schemaVersion: 2, artifacts: {}, specs: {} }),
      "utf8",
    );
    await expect(DisclosureLog.open(d)).rejects.toThrow(/schemaVersion/);
  });

  it("sees another process's writes only after refresh", async () => {
    const d = await dir();
    const reader = await DisclosureLog.open(d);
    const writer = await DisclosureLog.open(d);
    await writer.announceArtifact("0x2", "bafy-late");

    expect(reader.artifactCidFor("0x2")).toBeUndefined();
    await reader.refresh();
    expect(reader.artifactCidFor("0x2")).toBe("bafy-late");
  });

  it("carries the signature the chain discarded alongside the cid", async () => {
    const d = await dir();
    const log = await DisclosureLog.open(d);
    await log.announceArtifact("0xBeef", {
      cid: "bafy-artifact",
      signature: "0xdeadbeef",
      sigDeadline: "1800000000",
    });

    expect(log.artifactRecordFor("0xbeef")).toEqual({
      cid: "bafy-artifact",
      signature: "0xdeadbeef",
      sigDeadline: "1800000000",
    });
    expect(log.artifactCidFor("0xBEEF")).toBe("bafy-artifact");

    // Re-announcing the same fact must not rewrite the file; announcing a *different*
    // signature for the same run hash must, because that is a new claim about the run.
    const before = await readFile(path.join(d, "disclosure.json"), "utf8");
    await log.announceArtifact("0xBeef", {
      cid: "bafy-artifact",
      signature: "0xdeadbeef",
      sigDeadline: "1800000000",
    });
    expect(await readFile(path.join(d, "disclosure.json"), "utf8")).toBe(before);

    await log.announceArtifact("0xBeef", { cid: "bafy-artifact", signature: "0xother" });
    expect((await DisclosureLog.open(d)).artifactRecordFor("0xbeef")?.signature).toBe("0xother");
  });

  it("reads a bare-cid announcement from an older or hand-written file", async () => {
    const d = await dir();
    await writeFile(
      path.join(d, "disclosure.json"),
      JSON.stringify({ schemaVersion: 1, artifacts: { "0xab": "bafy-just-cid" }, specs: {} }),
      "utf8",
    );
    const log = await DisclosureLog.open(d);
    expect(log.artifactCidFor("0xab")).toBe("bafy-just-cid");
    expect(log.artifactRecordFor("0xab")).toEqual({ cid: "bafy-just-cid" });
  });

  it("counts what it holds", async () => {
    const d = await dir();
    const log = await DisclosureLog.open(d);
    await log.announceArtifact("0x1", "bafy-a");
    await log.announceArtifact("0x2", "bafy-b");
    await log.announceSpec("0x3", "bafy-c");
    expect(log.size).toEqual({ artifacts: 2, specs: 1 });
  });
});

/**
 * The manifest pointer, and the two ways it can be lost.
 *
 * `announceArtifact` replaces a record wholesale and `sameRecord` short-circuits an announce
 * that looks equal. Both are correct for the fields they were written with, and both are a
 * silent data-loss path the moment a new field appears: a merge that forgot the signature
 * would erase it, and an equality test that ignored the manifest would report "already
 * announced" and drop the pointer forever. These two cases are here to make that expensive.
 */
describe("announceManifest", () => {
  const RUN = `0x${"9c".repeat(32)}`;

  it("refuses a manifest for a run nothing announced", async () => {
    const d = await dir();
    const log = await DisclosureLog.open(d);
    await expect(log.announceManifest(RUN, { cid: "bafy-m", digest: "0xdead" })).rejects.toThrow(
      DisclosureError,
    );
    await expect(log.announceManifest(RUN, { cid: "bafy-m", digest: "0xdead" })).rejects.toThrow(
      /announce the run before its manifest/,
    );
  });

  it("attaches to the existing record without disturbing the signature it already carried", async () => {
    const d = await dir();
    const log = await DisclosureLog.open(d);
    await log.announceArtifact(RUN, { cid: "bafy-artifact", signature: "0xsig", sigDeadline: "1800" });
    await log.announceManifest(RUN, { cid: "bafy-m", digest: "0xdead" });

    const record = log.artifactRecordFor(RUN);
    expect(record).toEqual({
      cid: "bafy-artifact",
      signature: "0xsig",
      sigDeadline: "1800",
      manifestCid: "bafy-m",
      manifestDigest: "0xdead",
    });
  });

  it("survives a reopen — the loader has to keep the fields the writer added", async () => {
    const d = await dir();
    const writer = await DisclosureLog.open(d);
    await writer.announceArtifact(RUN, "bafy-artifact");
    await writer.announceManifest(RUN, { cid: "bafy-m", digest: "0xdead" });

    const reader = await DisclosureLog.open(d);
    expect(reader.artifactRecordFor(RUN)).toEqual({
      cid: "bafy-artifact",
      manifestCid: "bafy-m",
      manifestDigest: "0xdead",
    });
  });

  it("is idempotent, and re-announcing a different manifest is a change, not a no-op", async () => {
    const d = await dir();
    const log = await DisclosureLog.open(d);
    await log.announceArtifact(RUN, "bafy-artifact");
    await log.announceManifest(RUN, { cid: "bafy-m", digest: "0xdead" });
    const written = await readFile(path.join(d, "disclosure.json"), "utf8");

    await log.announceManifest(RUN, { cid: "bafy-m", digest: "0xdead" });
    expect(await readFile(path.join(d, "disclosure.json"), "utf8")).toBe(written);

    await log.announceManifest(RUN, { cid: "bafy-other", digest: "0xbeef" });
    expect((await log.artifactRecordFor(RUN))?.manifestCid).toBe("bafy-other");
  });
});
