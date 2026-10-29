import { afterEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CidStore, cidV1Raw, sha256 } from "@crucible/cidstore";
import { keccak256, toBytes, toHex } from "viem";
import { createApp } from "../src/app.js";
import { createContentSource, digestToCidMap } from "../src/content.js";
import type { ReadModel } from "@crucible/indexer";

/**
 * `GET /content/:id` — the read side of the disclosure contract.
 *
 * These tests write a real content directory and a real disclosure file. A stub would only prove
 * the route dispatches on shapes the route itself invented; what is worth knowing is the store's
 * own behaviour — bytes that no longer hash to the id they sit under, a path that will not open,
 * an entry disclosed after the first request.
 */

const dirs: string[] = [];

function workspace(): { dir: string; disclosure: string } {
  const dir = mkdtempSync(join(tmpdir(), "crucible-content-"));
  dirs.push(dir);
  const disclosure = join(dir, "disclosure", "disclosure.json");
  mkdirSync(join(dir, "disclosure"), { recursive: true });
  return { dir, disclosure };
}

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}

/**
 * The store, opened the way every *writer* opens it.
 *
 * `scripts/seed-content.mjs:72` and `apps/juror/src/main.ts:51` both do
 * `new CidStore({ dir: join(contentDir, "store") })`, so the bytes land in
 * `<contentDir>/store/data`. A test that wrote the store at `<contentDir>`
 * itself would be testing a layout no writer produces - which is exactly how
 * the reader drifted: it looked in `<contentDir>/data`, a directory that
 * nothing ever creates, so every disclosed suite answered 503 "the content
 * store could not be read" while the bytes sat one directory away.
 *
 * So the test writes where the writers write, and the reader has to follow.
 */
function writerStore(contentDir: string): CidStore {
  return new CidStore({ dir: join(contentDir, "store") });
}

afterEach(() => {
  while (dirs.length) {
    const d = dirs.pop();
    if (d) rmSync(d, { recursive: true, force: true });
  }
});

function filesUnder(root: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(root)) {
    const full = join(root, entry);
    if (statSync(full).isDirectory()) out.push(...filesUnder(full));
    else out.push(full);
  }
  return out;
}

const EMPTY_MODEL = {
  trials: new Map(),
  agents: new Map(),
  runs: new Map(),
  disputes: new Map(),
  appliedLogs: new Set(),
  version: 0,
} satisfies ReadModel;

function appWith(lookup?: ReturnType<typeof createContentSource>) {
  return createApp({ getModel: () => EMPTY_MODEL, contentLookup: lookup }, { rateLimit: false });
}

describe("serving what was pinned", () => {
  it("returns the text a CID names, marked immutable", async () => {
    const { dir } = workspace();
    const suite = "forge test --match-path 'test/Suite.t.sol'";
    const cid = writerStore(dir).put(suite);

    const res = await appWith(createContentSource(dir, () => new Map())).request(`/content/${cid}`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/plain; charset=utf-8");
    expect(res.headers.get("cache-control")).toContain("immutable");
    expect(await res.text()).toBe(suite);
  });

  it("serves bytes that are not text without pretending they are", async () => {
    const { dir } = workspace();
    const blob = new Uint8Array([0xff, 0xfe, 0x00, 0x41]);
    const cid = writerStore(dir).put(blob);

    const res = await appWith(createContentSource(dir, () => new Map())).request(`/content/${cid}`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/octet-stream");
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(blob);
  });

  /**
   * The reader and the writers must agree on where the store lives.
   *
   * This is the whole bug, written as a test: the writer's layout is
   * `<contentDir>/store/data` (both writers put it there), and the reader
   * opened `<contentDir>` and so looked in `<contentDir>/data` — a directory
   * no writer creates. The symptom on the deployed box was a 503 whose reason
   * named a path that was never the store's, for every disclosed suite.
   *
   * The assertion is deliberately about the *layout*, not about one fixture:
   * the bytes are written by `writerStore`, exactly as `seed-content.mjs` and
   * the juror write them, and the reader has to find them. Reverting the
   * reader to `<contentDir>` turns this red.
   */
  it("reads the bytes the writers wrote, at the path the writers wrote them", async () => {
    const { dir } = workspace();
    const suite = "the bytes a sponsor pinned";
    const cid = writerStore(dir).put(suite);

    // The shape on disk, asserted so the test says what broke if it goes red.
    const written = filesUnder(dir).find((f) => f.includes(toHex(sha256(suite)).slice(2)));
    expect(written, "the writer did not put the bytes on disk where it says it does").toBeTruthy();

    const res = await appWith(createContentSource(dir, () => new Map())).request(`/content/${cid}`);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe(suite);
  });

  it("answers a valid CID nobody pinned here with 404, and says the content may exist elsewhere", async () => {
    const elsewhere = writerStore(tempDir("crucible-other-")).put("somewhere else's bytes");
    const { dir } = workspace();
    // This host does have a store — it just does not hold that entry. Provisioning it is what
    // separates "not here" from "no store here", and the two answer with different statuses.
    writerStore(dir).put("something this host pinned earlier");

    const res = await appWith(createContentSource(dir, () => new Map())).request(`/content/${elsewhere}`);
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error).toMatch(/not pinned on this host/);
    expect(body.meaning).toBe("the content may exist elsewhere");
  });

  it("answers 503 for a content directory that was never provisioned, not 404", async () => {
    // The deployment state this distinguishes: compose mounts `content:/content:ro`, and a stack
    // that came up without the volume has an empty path where a store should be. Saying "nobody
    // pinned those bytes" about that would send a reader to ask a sponsor for a suite this host
    // never had a place to keep.
    const { dir } = workspace();
    const res = await appWith(createContentSource(dir, () => new Map())).request(
      `/content/${cidV1Raw("anything")}`,
    );
    expect(res.status).toBe(503);
    expect((await res.json()).reason).toMatch(/no content store/);
  });
});

describe("the digest a trial carries", () => {
  function disclose(disclosureFile: string, bytes: string, cid: string): string {
    const digest = keccak256(toBytes(bytes));
    // Written the way `ContentBridge` writes it: the chain's `0x` digest, lowercased, as the key.
    writeFileSync(disclosureFile, JSON.stringify({ schemaVersion: 1, artifacts: {}, specs: { [digest]: cid } }));
    return digest;
  }

  it("follows a disclosed digest to the bytes it names", async () => {
    const { dir, disclosure } = workspace();
    const suite = "contract Suite { function test_a() public {} }";
    const cid = writerStore(dir).put(suite);
    const digest = disclose(disclosure, suite, cid);

    const res = await appWith(createContentSource(dir, () => digestToCidMap(disclosure, () => {}))).request(
      `/content/${digest}`,
    );
    expect(res.status).toBe(200);
    expect(await res.text()).toBe(suite);
    // A digest answer depends on a mapping that can appear at any moment, so it is not cacheable
    // the way the CID's own bytes are.
    expect(res.headers.get("cache-control")).not.toContain("immutable");
  });

  it("refuses to invent bytes for a digest nobody disclosed", async () => {
    const { dir } = workspace();
    const res = await appWith(createContentSource(dir, () => new Map())).request(`/content/${`0x${"11".repeat(32)}`}`);
    expect(res.status).toBe(404);
    expect((await res.json()).reason).toMatch(/No CID is published/);
  });

  it("reads the disclosure map again on the next request", async () => {
    const { dir, disclosure } = workspace();
    const suite = "delayed disclosure";
    const cid = writerStore(dir).put(suite);
    const app = appWith(createContentSource(dir, () => digestToCidMap(disclosure, () => {})));

    const before = await app.request(`/content/${keccak256(toBytes(suite))}`);
    expect(before.status).toBe(404);

    disclose(disclosure, suite, cid);
    const after = await app.request(`/content/${keccak256(toBytes(suite))}`);
    expect(after.status).toBe(200);
    expect(await after.text()).toBe(suite);
  });

  it("reports a malformed disclosure file instead of answering not-disclosed", async () => {
    const { dir, disclosure } = workspace();
    writeFileSync(disclosure, "{ this is not json");
    const faults: string[] = [];
    const lookup = createContentSource(dir, () => digestToCidMap(disclosure, (m) => faults.push(m)));

    const res = await appWith(lookup).request(`/content/${`0x${"22".repeat(32)}`}`);
    expect(res.status).toBe(404);
    expect(faults).toHaveLength(1);
    expect(faults[0]).toContain(disclosure);
  });
});

describe("when the store itself is the problem", () => {
  it("answers 503 when this host mounted no content at all", async () => {
    const res = await appWith(undefined).request(`/content/${cidV1Raw("anything")}`);
    expect(res.status).toBe(503);
    expect((await res.json()).meaning).toBe("no store here, not no such content");
  });

  it("answers 500 when the bytes under a CID do not hash to it", async () => {
    const { dir } = workspace();
    const cid = writerStore(dir).put("original bytes");
    // The disk backend stores by the hex sha256 of the content; corrupt that file the way a
    // partial write or a failing disk would.
    const key = toHex(sha256("original bytes")).slice(2);
    const target = filesUnder(dir).find((f) => f.includes(key));
    if (!target) throw new Error(`no stored file matched ${key} under ${dir}`);
    writeFileSync(target, "tampered bytes that no longer hash to the id they are stored under");

    const res = await appWith(createContentSource(dir, () => new Map())).request(`/content/${cid}`);
    expect(res.status).toBe(500);
    expect((await res.json()).error).toMatch(/do not hash/);
  });

  it("answers 503 when the content path cannot be opened as a store", async () => {
    const pathIsAFile = join(tempDir("crucible-file-path-"), "a-file");
    writeFileSync(pathIsAFile, "this path is a file, not a store");

    const res = await appWith(createContentSource(pathIsAFile, () => new Map())).request(
      `/content/${cidV1Raw("anything")}`,
    );
    expect(res.status).toBe(503);
    expect((await res.json()).reason).toContain(pathIsAFile);
  });
});

describe("the id itself", () => {
  it("says nothing named those bytes for a string that is neither form", async () => {
    const { dir } = workspace();
    const res = await appWith(createContentSource(dir, () => new Map())).request("/content/not-a-cid");
    expect(res.status).toBe(404);
    expect((await res.json()).reason).toBe("Not a CID and not a 32-byte digest");
  });

  it("does not treat a traversal as an id", async () => {
    const { dir } = workspace();
    const res = await appWith(createContentSource(dir, () => new Map())).request(
      `/content/${encodeURIComponent("../../disclosure/disclosure.json")}`,
    );
    expect(res.status).toBe(404);
    expect((await res.json()).reason).toMatch(/Not a CID/);
  });
});
