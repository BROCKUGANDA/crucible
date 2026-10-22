import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { CidStore, ContentBridge, DisclosureLog } from "@crucible/cidstore";
import { digestOfContent } from "@crucible/smith";
import { ContentService, type TreeTarget } from "../src/content.js";

/**
 * The content layer with real bytes on real disk.
 *
 * Everything here existed before only as an inline `async () => "c".repeat(40)` in someone
 * else's test, which is how a pipeline can look complete and carry nothing. These tests use a
 * real store directory and a real disclosure file, and they exercise the two properties that
 * make the difference: pin-then-post round-trips, and a pinned tree cannot write outside the
 * bench it is being unpacked into.
 */

let dir: string;
const services: string[] = [];

beforeAll(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "crucible-content-"));
});

afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

async function service(name: string): Promise<{ svc: ContentService; dir: string }> {
  const root = path.join(dir, name);
  const svc = new ContentService({
    bridge: new ContentBridge({
      store: new CidStore({ dir: path.join(root, "store") }),
      disclosure: await DisclosureLog.open(path.join(root, "disclosure")),
      digestOf: digestOfContent,
    }),
  });
  services.push(root);
  return { svc, dir: root };
}

/** A bench stand-in: an in-memory tree with the three operations this service performs. */
function bench(initial: Record<string, string> = {}): TreeTarget & {
  written: Record<string, string>;
  setListing(files: Record<string, string>): void;
} {
  const written: Record<string, string> = { ...initial };
  const target = {
    repoDir: "/bench",
    written,
    setListing(files: Record<string, string>) {
      for (const [k, v] of Object.entries(files)) written[k] = v;
    },
    async runSuite(command: string) {
      if (command.startsWith("find")) {
        return { stdout: Object.keys(written).sort().join("\n"), code: 0 };
      }
      const name = /base64 -w0 "(.+)"/.exec(command)?.[1];
      if (name && name in written) {
        return { stdout: Buffer.from(written[name]!, "utf8").toString("base64"), code: 0 };
      }
      return { stdout: "", code: 1 };
    },
    async writeFile(relative: string, contents: string) {
      written[relative] = contents;
      return relative;
    },
  };
  return target;
}

describe("pin before you post", () => {
  it("a pinned spec answers to the digest the chain would hold", async () => {
    const { svc } = await service("spec");
    const text = "Implement a counter that cannot overflow.";
    const pinned = await svc.pinText(text);

    // The exact rule the seeds obey: the chain stores keccak over the bytes, so the bytes
    // have to exist somewhere before that number means anything.
    expect(pinned.digest).toBe(digestOfContent(text));
    expect(await svc.fetchSpec(pinned.digest)).toBe(text);
  });

  it("resolves a digest in a second process, over the same directory", async () => {
    const { svc, dir: root } = await service("cross");
    const pinned = await svc.pinText("suite body");

    const reader = new ContentService({
      bridge: new ContentBridge({
        store: new CidStore({ dir: path.join(root, "store") }),
        disclosure: await DisclosureLog.open(path.join(root, "disclosure")),
        digestOf: digestOfContent,
      }),
    });
    expect(await reader.fetchSpec(pinned.digest)).toBe("suite body");
  });

  it("refuses a digest that never had content behind it", async () => {
    const { svc } = await service("unbacked");
    // What `Extend.s.sol` used to produce: a commitment mixed with block.timestamp, which
    // no amount of later pinning can resolve. The refusal has to say that, not "not found".
    await expect(svc.fetchSpec(`0x${"ab".repeat(32)}`)).rejects.toThrow(/nothing was ever announced/);
  });
});

describe("unpacking a pinned suite", () => {
  it("writes every file into the bench and returns a recomputable digest", async () => {
    const { svc } = await service("suite");
    const tree = { files: { "test/Suite.t.sol": "contract Suite {}", "src/Forge.sol": "contract Forge {}" } };
    const pinned = await svc.pinSuite(tree);
    expect(pinned.files).toBe(2);

    const target = bench();
    const sha = await svc.fetchSuite(pinned.cid, target);
    expect(sha).toMatch(/^0x[0-9a-f]{40}$/);
    expect(target.written["test/Suite.t.sol"]).toBe("contract Suite {}");
    expect(target.written["src/Forge.sol"]).toBe("contract Forge {}");

    const again = await svc.fetchSuite(pinned.cid, bench());
    expect(again).toBe(sha);
  });

  it("refuses a suite whose entry would escape the bench", async () => {
    const { svc } = await service("escape");
    const hostile = { files: { "../../outside.sol": "written where it should not be" } };
    const pinned = await svc.pinSuite(hostile as never);

    const target = bench();
    await expect(svc.fetchSuite(pinned.cid, target)).rejects.toThrow(/unsafe path/);
    // Refused before the write, not after: nothing landed anywhere.
    expect(Object.keys(target.written).length).toBe(0);
  });

  it("refuses an empty suite rather than handing the runner a bench with nothing in it", async () => {
    const { svc } = await service("empty");
    const pinned = await svc.pinSuite({ files: {} });
    await expect(svc.fetchSuite(pinned.cid, bench())).rejects.toThrow(/holds no files/);
  });
});

describe("pinning what the bench produced", () => {
  it("uploads the repo as a tree whose cid answers to its bytes", async () => {
    const { svc } = await service("repo");
    const target = bench({ "src/Forge.sol": "contract Forge { uint256 x; }" });
    const cid = await svc.uploadRepo(target);
    expect(cid).toMatch(/^bafk/);

    const back = await svc.readArtifact<{ files: Record<string, string> }>(cid);
    expect(back.files["src/Forge.sol"]).toBe("contract Forge { uint256 x; }");
  });

  it("round-trips a file whose contents contain newlines and quotes", async () => {
    const { svc } = await service("tricky");
    const awkward = 'line one\nline "two"\\\n';
    const cid = await svc.uploadRepo(bench({ "a.txt": awkward }));
    const back = await svc.readArtifact<{ files: Record<string, string> }>(cid);
    expect(back.files["a.txt"]).toBe(awkward);
  });

  it("publishes a run with the signature and deadline the chain discards", async () => {
    const { svc } = await service("artifact");
    const artifact = { trialId: 1, runHash: `0x${"11".repeat(32)}`, testResults: [] };
    const runHash = `0x${"22".repeat(32)}`;
    const cid = await svc.publishArtifact(artifact, runHash, `0x${"cd".repeat(65)}`, "1800000000");

    const record = await svc.recordForRun(runHash);
    expect(record?.cid).toBe(cid);
    expect(record?.signature).toBe(`0x${"cd".repeat(65)}`);
    expect(record?.sigDeadline).toBe("1800000000");
    expect(await svc.readArtifact(cid)).toEqual(artifact);
  });

  it("logs are pinned and readable", async () => {
    const { svc } = await service("logs");
    const cid = await svc.uploadLogs("Ran 2 tests. 0 failed.");
    expect(await svc.fetchSpec(cid)).toBe("Ran 2 tests. 0 failed.");
  });
});
