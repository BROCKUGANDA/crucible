import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { keccak256, stringToHex } from "viem";
import { CidStore, ContentBridge, DisclosureLog } from "@crucible/cidstore";
import { computeRunHash, digestOfContent, type RunArtifact } from "@crucible/smith";

/**
 * The content layer, end to end across two processes.
 *
 * Until this existed, every function that moved bytes between a run and a verifier was a
 * test fake: `RunnerDeps.fetchSpec`/`fetchSuite`/`uploadRepo`/`uploadLogs` and
 * `VerifyInput.fetchArtifact`/`rerunSuite` were supplied only by unit tests, so the
 * `specCID`/`testsCID`/`repoCID` inside an artifact named digests of bytes that were never
 * stored anywhere, and ADR-0005's deterministic re-run could not execute as shipped.
 *
 * These tests use a real directory, real keccak, and two separate `CidStore`/`DisclosureLog`
 * instances over it — one standing in for the process that ran the work, one for the process
 * that arrives later to check it. That handoff is the entire claim, and it cannot be shown
 * with a mock.
 */

let dir: string;

beforeAll(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "crucible-content-"));
});

afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

/** Two processes sharing one content directory. */
async function pair() {
  const writerStore = new CidStore({ dir: path.join(dir, "store") });
  const writerDisclosure = await DisclosureLog.open(path.join(dir, "disclosure"));
  const writer = new ContentBridge({ store: writerStore, disclosure: writerDisclosure, digestOf: digestOfContent });

  // Built fresh, deliberately: a verifier must not need the writer's memory, only the disk.
  const readerStore = new CidStore({ dir: path.join(dir, "store") });
  const readerDisclosure = await DisclosureLog.open(path.join(dir, "disclosure"));
  const reader = new ContentBridge({ store: readerStore, disclosure: readerDisclosure, digestOf: digestOfContent });

  return { writer, reader, writerStore };
}

function artifact(over: Partial<RunArtifact> = {}): RunArtifact {
  return {
    schemaVersion: "1.0.0",
    trialId: 1,
    agentId: 7,
    specCID: "bafy.example/spec",
    testsCID: "bafy.example/tests",
    repoCID: "bafy.example/repo",
    commitSHA: "0".repeat(40),
    suiteCommand: "forge test --match-path 'test/Suite.t.sol'",
    testResults: [
      { name: "test_A", status: "pass", durationMs: 12 },
      { name: "test_B", status: "pass", durationMs: 31 },
    ],
    logsCID: "bafy.example/logs",
    durationMs: 4_300,
    model: "z-ai/glm-5.3-flash",
    startedAt: 1_700_000_000,
    finishedAt: 1_700_000_004,
    runnerAddress: "0x1111111111111111111111111111111111111111",
    chainId: 31337,
    verifyingContract: "0x2222222222222222222222222222222222222222",
    ...over,
  };
}

describe("pinning spec content a chain already committed to", () => {
  it("a literal digest from a running chain resolves to the bytes it was hashed from", async () => {
    const { writer, reader } = await pair();

    // `Demo.s.sol` posts keccak256("spec-1"). That is an ordinary keccak over six ASCII
    // bytes, so the content behind an existing commitment is recoverable without touching
    // a single line of Solidity — the bytes were always "spec-1".
    const pinned = await writer.pinContent("spec-1");
    expect(pinned.digest).toBe(keccak256(stringToHex("spec-1")));

    const back = await reader.contentForDigest(pinned.digest);
    expect(back).toBe("spec-1");
  });

  it("the digest and the content id are different numbers, and both are needed", async () => {
    const { writer, reader } = await pair();
    const pinned = await writer.pinContent("the spec text a sponsor wrote");

    expect(pinned.cid).not.toBe(pinned.digest);
    // Chain-side lookups only ever have the digest, which is why the announcement exists.
    expect(await reader.contentForDigest(pinned.digest)).toBe("the spec text a sponsor wrote");
  });

  it("a digest computed over something that was never pinned says so, rather than returning nothing", async () => {
    const { reader } = await pair();

    // 0x5bc5… is a real trial on the live demo. `Extend.s.sol` derives it from
    // abi.encodePacked("spec-anvil", block.timestamp), so no bytes could ever be announced
    // for it after the fact. The refusal has to name that, because "not found" and "this
    // commitment never had content" are different operational answers.
    await expect(reader.contentForDigest("0x5bc5eeedcdb4b6204e9db1959c2708a7a7bb51782e8d16c9d21c7a50f6d59223"))
      .rejects.toThrow(/never announced|never be resolved/);
  });
});

describe("a disclosure is a pointer, not an authority", () => {
  it("refuses bytes that no longer hash to the content id the disclosure named", async () => {
    const { writer, reader } = await pair();
    const pinned = await writer.pinContent("honest suite text");

    // Tamper with the store on disk the way an attacker or a bad deploy would: keep the
    // name, change the bytes. The store nests entries under directories, so find the file
    // that actually holds the text rather than guessing at the layout.
    const storeDir = path.join(dir, "store");
    const entries = (await readdir(storeDir, { recursive: true })) as string[];
    let tampered = false;
    for (const rel of entries) {
      const full = path.join(storeDir, rel);
      const raw = await readFile(full, "utf8").catch(() => null);
      if (raw === null) continue; // a directory, or unreadable
      if (raw === "honest suite text") {
        await writeFile(full, "tampered suite text", "utf8");
        tampered = true;
      }
    }
    expect(tampered, "the store wrote the pinned text somewhere under its directory").toBe(true);

    // Not a silent null, and not a verification that proceeds: a mismatch must be a fault.
    await expect(reader.contentForDigest(pinned.digest)).rejects.toThrow(/not hash to/);
  });

  it("a second process reads what the first one wrote", async () => {
    const { writer, reader } = await pair();
    await writer.pinContent("cross-process content");

    const reopened = await DisclosureLog.open(path.join(dir, "disclosure"));
    const store2 = new CidStore({ dir: path.join(dir, "store") });
    const bridge2 = new ContentBridge({ store: store2, disclosure: reopened, digestOf: digestOfContent });
    expect(await bridge2.contentForDigest(keccak256(stringToHex("cross-process content")))).toBe(
      "cross-process content",
    );
    expect(reader).toBeDefined();
  });
});

describe("announcing the run the chain recorded", () => {
  it("keys the artifact by the chain's own run hash, not by a hash of the JSON", async () => {
    const { writer, reader } = await pair();
    const a = artifact();
    const runHash = computeRunHash(a);

    // The distinction that decides whether verification can find anything: the chain's run
    // hash is keccak over the RFC 8785 canonicalization, not over `JSON.stringify`.
    expect(runHash).not.toBe(keccak256(stringToHex(JSON.stringify(a))));

    await writer.pinArtifact(a, {
      runHash,
      signature: "0x" + "ab".repeat(65),
      sigDeadline: "1800000000",
    });

    const record = await reader.artifactRecord(runHash);
    expect(record, "the verifier finds the announcement by the run hash alone").toBeTruthy();
    expect(record!.signature).toBe("0x" + "ab".repeat(65));
    expect(record!.sigDeadline).toBe("1800000000");

    const fetched = await reader.artifactForCid<RunArtifact>(record!.cid);
    expect(computeRunHash(fetched)).toBe(runHash);
    expect(fetched.testResults.map((t) => t.name)).toEqual(["test_A", "test_B"]);
  });

  it("refuses to hand back an artifact whose bytes were edited after pinning", async () => {
    const { writer, reader } = await pair();
    const a = artifact();
    const runHash = computeRunHash(a);
    const pinned = await writer.pinArtifact(a, {
      runHash,
      signature: "0x" + "cd".repeat(65),
      sigDeadline: "1800000001",
    });

    const storeDir = path.join(dir, "store");
    const files = await readdir(storeDir, { recursive: true }).catch(() => [] as string[]);
    for (const f of files as string[]) {
      const full = path.join(storeDir, f);
      const raw = await readFile(full, "utf8").catch(() => null);
      // Corrupt only the JSON entries, leaving spec text alone.
      if (raw && raw.includes("forge test --match-path")) {
        await writeFile(full, raw.replace("test_A", "test_Z"), "utf8");
      }
    }

    await expect(reader.artifactForCid(pinned.cid)).rejects.toThrow(/not hash to/);
  });

  it("reports a missing artifact as missing, not as an empty object", async () => {
    const { reader } = await pair();
    await expect(reader.artifactForCid("bafy.nothing.here")).rejects.toThrow(/not here|not valid JSON/);
  });
});
