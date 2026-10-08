import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  CidStore,
  CidStoreError,
  ContentCorruptedError,
  EntryTooLargeError,
  StoreFullError,
  canonicalJson,
  cidV0,
  cidV1Raw,
  sha256,
  toBytes,
  toHex,
} from "../src/index.js";

const ARTIFACT = JSON.stringify({ trialId: 7, verdict: "agent-wins" });
const keyOf = (content: string | Uint8Array): string => toHex(sha256(content));
const sizeOf = (content: string): number => new TextEncoder().encode(content).length;

let dirs: string[] = [];

/** One directory per test, deleted after: a content store is only interesting on a real filesystem. */
async function freshDir(): Promise<string> {
  const base = await mkdtemp(join(tmpdir(), "crucible-cidstore-"));
  dirs.push(base);
  return base;
}

const dataFiles = (dir: string): string[] => readdirSync(join(dir, "data"));

beforeEach(async () => {
  await freshDir();
});

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("put and get", () => {
  it("returns the id the content computes to and reads the content back", () => {
    const store = CidStore.inMemory();
    const cid = store.put(ARTIFACT);

    expect(cid).toBe(cidV1Raw(ARTIFACT));
    expect(store.get(cid)).toBe(ARTIFACT);
  });

  it("accepts bytes and hands back exactly those bytes", () => {
    const store = CidStore.inMemory();
    const payload = new Uint8Array([0, 1, 2, 250, 251, 252, 253, 254, 255]);
    const cid = store.put(payload);

    expect(cid).toBe(cidV1Raw(payload));
    expect(store.getBytes(cid)).toEqual(payload);
  });

  it("distinguishes stored-empty from missing, which is the difference between a null and a lie", () => {
    const store = CidStore.inMemory();
    const empty = store.put("");

    expect(store.get(empty)).toBe("");
    expect(store.getBytes(empty)).toEqual(new Uint8Array(0));
    expect(store.has(empty)).toBe(true);
    expect(store.get(cidV1Raw("never stored"))).toBe(null);
    expect(store.has(cidV1Raw("never stored"))).toBe(false);
  });

  it("returns null for text that is not an id rather than throwing at a verifier", () => {
    const store = CidStore.inMemory();
    for (const junk of ["", "not-a-cid", "Qm", "0".repeat(46), "bafkrei"]) {
      expect([junk, store.get(junk)]).toEqual([junk, null]);
      expect(store.has(junk)).toBe(false);
      expect(store.remove(junk)).toBe(false);
    }
  });

  it("reports the id it would use without storing anything", () => {
    const store = CidStore.inMemory();
    expect(store.cidFor(ARTIFACT)).toBe(cidV1Raw(ARTIFACT));
    expect(store.stats().entries).toBe(0);
    expect(store.list()).toEqual([]);
  });
});

describe("content addressing", () => {
  it("stores identical content once, however many times it is put", () => {
    const store = CidStore.inMemory();
    const first = store.put(ARTIFACT);
    const second = store.put(ARTIFACT);

    expect(second).toBe(first);
    expect(store.stats().entries).toBe(1);
    expect(store.stats().bytes).toBe(sizeOf(ARTIFACT));
  });

  it("treats the text and the bytes of the same message as the same entry", () => {
    const store = CidStore.inMemory();
    const asText = store.put(ARTIFACT);
    const asBytes = store.put(new TextEncoder().encode(ARTIFACT));

    expect(asBytes).toBe(asText);
    expect(store.stats().entries).toBe(1);
  });

  it("re-putting is a no-op that does not move the entry to the back of the eviction queue", () => {
    const store = CidStore.inMemory({ maxEntries: 3 });
    const one = store.put("one");
    const two = store.put("two");
    const three = store.put("three");

    expect(store.put("one")).toBe(one);
    expect(store.stats().entries).toBe(3);
    expect(store.list()).toEqual([one, two, three]);

    const four = store.put("four");
    expect(store.has(one)).toBe(false);
    expect(store.has(two)).toBe(true);
    expect(store.list()).toEqual([two, three, four]);
  });

  it("resolves either spelling of an id, because the entry is the multihash not the text", () => {
    const store = new CidStore({ cidVersion: "v0" });
    const v0 = store.put(ARTIFACT);

    expect(v0).toBe(cidV0(ARTIFACT));
    expect(store.list()).toEqual([v0]);
    expect(store.get(cidV1Raw(ARTIFACT))).toBe(ARTIFACT);
    expect(store.has(cidV1Raw(ARTIFACT))).toBe(true);
    expect(store.remove(cidV1Raw(ARTIFACT))).toBe(true);
    expect(store.has(v0)).toBe(false);
  });

  it("keeps a v1 store's ids fetchable by their v0 spelling too", () => {
    const store = CidStore.inMemory();
    expect(store.put(ARTIFACT)).toBe(cidV1Raw(ARTIFACT));
    expect(store.get(cidV0(ARTIFACT))).toBe(ARTIFACT);
  });

  it("does not hand out the array it holds, so a reader cannot rewrite an id's content", () => {
    const stores = [CidStore.inMemory(), new CidStore({ dir: dirs[0]! })];
    for (const store of stores) {
      const payload = new TextEncoder().encode("pass 42 of 42");
      const cid = store.put(payload);

      payload[0] = 0x21;
      expect(store.getBytes(cid)).toEqual(new TextEncoder().encode("pass 42 of 42"));

      const read = store.getBytes(cid)!;
      read[1] = 0x21;
      expect(store.getBytes(cid)).toEqual(new TextEncoder().encode("pass 42 of 42"));
      expect(store.get(cid)).toBe("pass 42 of 42");
    }
  });

  it("separates content that differs by a single byte", () => {
    const store = CidStore.inMemory();
    const a = store.put("pass");
    const b = store.put("pasS");

    expect(a).not.toBe(b);
    expect(store.get(a)).toBe("pass");
    expect(store.get(b)).toBe("pasS");
    expect(store.stats().entries).toBe(2);
  });
});

describe("bounded: the per-entry limit", () => {
  it("refuses content over the limit and leaves the store exactly as it was", () => {
    const store = CidStore.inMemory({ maxEntryBytes: 16, maxBytes: 1024 });
    const kept = store.put("small");

    expect(() => store.put("x".repeat(17))).toThrow(EntryTooLargeError);
    expect(store.stats().entries).toBe(1);
    expect(store.get(kept)).toBe("small");
    expect(store.list()).toEqual([kept]);
  });

  it("accepts content exactly at the limit", () => {
    const store = CidStore.inMemory({ maxEntryBytes: 16, maxBytes: 1024 });
    expect(() => store.put("x".repeat(16))).not.toThrow();
    expect(store.stats().bytes).toBe(16);
    expect(store.stats().entries).toBe(1);
  });

  it("carries the refusal through as an error a runner can act on, with the numbers in it", () => {
    const store = CidStore.inMemory({ maxEntryBytes: 8, maxBytes: 1024 });
    let caught: unknown = null;
    try {
      store.put("x".repeat(9));
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(EntryTooLargeError);
    expect(caught).toBeInstanceOf(CidStoreError);
    expect((caught as EntryTooLargeError).bytes).toBe(9);
    expect((caught as EntryTooLargeError).limit).toBe(8);
  });

  it("clamps the per-entry limit to a ceiling the entry could never fit under", () => {
    const store = CidStore.inMemory({ maxBytes: 32, maxEntryBytes: 4096 });
    expect(store.stats().maxEntryBytes).toBe(32);
    expect(() => store.put("x".repeat(33))).toThrow(StoreFullError);
    expect(store.stats().entries).toBe(0);
  });
});

describe("bounded: eviction", () => {
  it("keeps the newest entries and drops the oldest once the count ceiling is reached", () => {
    const store = CidStore.inMemory({ maxEntries: 3 });
    const ids = ["one", "two", "three", "four", "five"].map((text) => store.put(text));

    expect(store.stats().entries).toBe(3);
    expect(store.get(ids[0]!)).toBe(null);
    expect(store.get(ids[1]!)).toBe(null);
    expect(store.get(ids[2]!)).toBe("three");
    expect(store.list()).toEqual([ids[2]!, ids[3]!, ids[4]!]);
  });

  it("honours the byte ceiling and evicts until the new entry fits", () => {
    const store = CidStore.inMemory({ maxBytes: 20, maxEntries: 100 });
    const small = store.put("aaaa");
    const bigger = store.put("b".repeat(20));

    expect(store.stats().bytes).toBe(20);
    expect(store.get(bigger)).toBe("b".repeat(20));
    expect(store.get(small)).toBe(null);

    const last = store.put("c".repeat(6));
    expect(store.stats().bytes).toBeLessThanOrEqual(20);
    expect(store.get(last)).toBe("c".repeat(6));
    expect(store.get(bigger)).toBe(null);
  });

  it("evicts the oldest first, not the smallest or the easiest", () => {
    const store = CidStore.inMemory({ maxBytes: 12, maxEntries: 100 });
    const first = store.put("1".repeat(6));
    const second = store.put("2".repeat(6));
    const third = store.put("3".repeat(6));
    const fourth = store.put("4".repeat(6));

    expect([store.has(first), store.has(second), store.has(third), store.has(fourth)]).toEqual([
      false,
      false,
      true,
      true,
    ]);
    expect(store.stats().bytes).toBe(12);
    expect(store.list()).toEqual([third, fourth]);
  });

  it("never evicts the entry it is asked to store", () => {
    const store = CidStore.inMemory({ maxBytes: 10, maxEntries: 1 });
    const only = store.put("0123456789");

    expect(store.get(only)).toBe("0123456789");
    expect(store.stats().entries).toBe(1);
    expect(store.stats().bytes).toBe(10);
    expect(store.put("0123456789")).toBe(only);
  });

  it("refuses content larger than the whole ceiling instead of emptying the store for it", () => {
    const store = CidStore.inMemory({ maxBytes: 16, maxEntries: 8 });
    const kept = store.put("kept");

    expect(() => store.put("x".repeat(17))).toThrow(StoreFullError);
    expect(store.get(kept)).toBe("kept");
    expect(store.stats().entries).toBe(1);
  });

  it("lets evicted content be published again", () => {
    const store = CidStore.inMemory({ maxEntries: 2 });
    const first = store.put("first");
    const second = store.put("second");
    const third = store.put("third");

    expect(store.get(first)).toBe(null);
    expect(store.list()).toEqual([second, third]);
    expect(store.put("first")).toBe(first);
    // Re-publishing is a fresh publication: it goes behind what is already held.
    expect(store.list()).toEqual([third, first]);
  });

  it("rejects nonsense limits at construction rather than storing without bounds", () => {
    expect(() => new CidStore({ maxBytes: 0 })).toThrow(CidStoreError);
    expect(() => new CidStore({ maxBytes: -1 })).toThrow(CidStoreError);
    expect(() => new CidStore({ maxBytes: 1.5 })).toThrow(CidStoreError);
    expect(() => new CidStore({ maxEntries: 0 })).toThrow(CidStoreError);
    expect(() => new CidStore({ maxEntries: 2.5 })).toThrow(CidStoreError);
  });
});

describe("disk backing", () => {
  it("writes the payload as one file named by its own digest", () => {
    const dir = dirs[0]!;
    const store = new CidStore({ dir });
    const cid = store.put(ARTIFACT);

    expect(dataFiles(dir)).toEqual([keyOf(ARTIFACT)]);
    expect(new Uint8Array(readFileSync(join(dir, "data", keyOf(ARTIFACT))))).toEqual(toBytes(ARTIFACT));
    expect(cid).toBe(cidV1Raw(ARTIFACT));
    expect(store.stats().dir).toBe(dir);
  });

  it("leaves no temporary files behind", () => {
    const dir = dirs[0]!;
    const store = new CidStore({ dir });
    store.put("one");
    store.put("two");
    store.put("three");

    expect(dataFiles(dir)).toHaveLength(3);
    expect(dataFiles(dir).every((name) => /^[0-9a-f]{64}$/.test(name))).toBe(true);
  });

  it("serves content published by a second store over the same directory", () => {
    const dir = dirs[0]!;
    const runner = new CidStore({ dir });
    const cid = runner.put(ARTIFACT);

    const argus = new CidStore({ dir });
    expect(argus.get(cid)).toBe(ARTIFACT);
    expect(argus.has(cid)).toBe(true);
    expect(argus.stats().entries).toBe(1);
    expect(argus.stats().bytes).toBe(sizeOf(ARTIFACT));
  });

  it("sees writes made by the other side after it was constructed", () => {
    const dir = dirs[0]!;
    const reader = new CidStore({ dir });
    const writer = new CidStore({ dir });

    expect(reader.stats().entries).toBe(0);
    const cid = writer.put("published later");
    expect(reader.get(cid)).toBe("published later");
    expect(reader.stats().entries).toBe(1);
    expect(reader.list()).toEqual([cid]);
  });

  it("evicts the other side's entry, because the accounting is the directory not a cache", () => {
    const dir = dirs[0]!;
    const runner = new CidStore({ dir, maxEntries: 2 });
    const first = runner.put("first");
    runner.put("second");

    const argus = new CidStore({ dir, maxEntries: 2 });
    const third = argus.put("third");

    expect(argus.stats().entries).toBe(2);
    expect(runner.get(first)).toBe(null);
    expect(runner.get(third)).toBe("third");
    expect(dataFiles(dir)).toHaveLength(2);
    expect(existsSync(join(dir, "data", keyOf("first")))).toBe(false);
  });

  it("counts bytes written by the other side against the ceiling", () => {
    const dir = dirs[0]!;
    const a = new CidStore({ dir, maxBytes: 24, maxEntries: 10 });
    const b = new CidStore({ dir, maxBytes: 24, maxEntries: 10 });

    const first = a.put("a".repeat(10));
    b.put("b".repeat(10));
    const survivor = a.put("c".repeat(10));

    expect(a.stats().bytes).toBeLessThanOrEqual(24);
    expect(b.stats().bytes).toBeLessThanOrEqual(24);
    expect(a.has(first)).toBe(false);
    expect(a.get(survivor)).toBe("c".repeat(10));
  });

  it("publishes in one store and is read back in eviction order by the other", () => {
    const dir = dirs[0]!;
    const writer = new CidStore({ dir });
    const ids = ["one", "two", "three", "four"].map((text) => writer.put(text));

    const reader = new CidStore({ dir, maxEntries: 2 });
    expect(reader.list()).toEqual(ids);

    const five = reader.put("five");
    expect(reader.list()).toEqual([ids[3]!, five]);
    expect(reader.get(ids[0]!)).toBe(null);
  });

  it("ignores files it did not write, including in its own directory", () => {
    const dir = dirs[0]!;
    const store = new CidStore({ dir });
    store.put(ARTIFACT);
    writeFileSync(join(dir, "data", "notes.txt"), " somebody else's ");
    mkdirSync(join(dir, "data", "not-an-entry"), { recursive: true });

    expect(store.stats().entries).toBe(1);
    expect(dataFiles(dir)).toHaveLength(3);
    expect(store.get(cidV1Raw(ARTIFACT))).toBe(ARTIFACT);
  });

  it("creates the directory it was pointed at, so a fresh host is an empty store", () => {
    const dir = join(dirs[0]!, "nested", "store");
    expect(existsSync(dir)).toBe(false);

    const store = new CidStore({ dir });
    const cid = store.put("made the path");
    expect(store.get(cid)).toBe("made the path");
    expect(existsSync(join(dir, "data"))).toBe(true);
  });

  it("removes an entry from the shared directory", () => {
    const dir = dirs[0]!;
    const store = new CidStore({ dir });
    const cid = store.put(ARTIFACT);

    expect(store.remove(cid)).toBe(true);
    expect(store.remove(cid)).toBe(false);
    expect(dataFiles(dir)).toEqual([]);
    expect(new CidStore({ dir }).get(cid)).toBe(null);
  });

  it("throws when the bytes behind an id are not those bytes, instead of reporting nothing", () => {
    const dir = dirs[0]!;
    const store = new CidStore({ dir });
    const cid = store.put("the real suite output");
    writeFileSync(join(dir, "data", keyOf("the real suite output")), "tampered output");

    expect(() => store.get(cid)).toThrow(ContentCorruptedError);
    expect(store.has(cid)).toBe(true);
    // An id that names nothing here is still a plain miss, not an error.
    expect(store.get(cidV1Raw("something else"))).toBe(null);
  });

  it("keeps working over a directory that already holds entries from an earlier process", () => {
    const dir = dirs[0]!;
    const first = new CidStore({ dir, maxEntries: 3 });
    const one = first.put("one");
    const two = first.put("two");
    const three = first.put("three");

    const second = new CidStore({ dir, maxEntries: 3 });
    expect(second.list()).toEqual([one, two, three]);
    const four = second.put("four");

    expect(second.stats().entries).toBe(3);
    expect(second.get(one)).toBe(null);
    expect(second.list()).toEqual([two, three, four]);
  });

  it("counts the bytes that are actually on the file, not the ones it thinks it wrote", () => {
    const dir = dirs[0]!;
    const store = new CidStore({ dir });
    const big = "log line\n".repeat(20_000);
    const cid = store.put(big);

    expect(statSync(join(dir, "data", keyOf(big))).size).toBe(sizeOf(big));
    expect(store.stats().bytes).toBe(sizeOf(big));
    expect(store.get(cid)).toBe(big);
    expect(store.getBytes(cid)!.length).toBe(sizeOf(big));
  });

  it("keeps a binary payload byte for byte through the filesystem, including NULs and UTF-8", () => {
    const dir = dirs[0]!;
    const store = new CidStore({ dir });
    const payload = Uint8Array.from([0x00, 0x0a, 0x0d, 0xed, 0xa0, 0x80, 0xff, 0xc3, 0xa9, 0xe4, 0xb8, 0xad]);
    const cid = store.put(payload);

    expect(dataFiles(dir)).toEqual([keyOf(payload)]);
    expect(store.getBytes(cid)).toEqual(payload);
    expect(new Uint8Array(readFileSync(join(dir, "data", keyOf(payload))))).toEqual(payload);
  });
});

describe("two processes on one directory", () => {
  it("lets a separate OS process recover the published bytes and confirm the id", () => {
    const dir = dirs[0]!;
    const store = new CidStore({ dir });
    const cid = store.put(ARTIFACT);

    // The child never imports this package: it walks the directory and hashes what it finds
    // with node's own crypto. If the name in the directory were not the digest of the file,
    // a verifier written in another language could not find this content either.
    const helper = fileURLToPath(new URL("./helpers/peek.cjs", import.meta.url));
    const lines = execFileSync(process.execPath, [helper, join(dir, "data")], { encoding: "utf8" })
      .trim()
      .split("\n");

    expect(lines).toHaveLength(1);
    const [name, digest, size] = lines[0]!.split("\t");
    expect(name).toBe(keyOf(ARTIFACT));
    expect(digest).toBe(keyOf(ARTIFACT));
    expect(size).toBe(String(sizeOf(ARTIFACT)));
    expect(cid).toBe(cidV1Raw(ARTIFACT));
  });

  it("lets that process see exactly the set of entries the store reports", () => {
    const dir = dirs[0]!;
    const store = new CidStore({ dir, maxEntries: 3 });
    const ids = ["a", "bb", "ccc", "dddd"].map((text) => store.put(text));
    const held = store.list();

    expect(held).toEqual(ids.slice(1));
    const helper = fileURLToPath(new URL("./helpers/peek.cjs", import.meta.url));
    const seen = execFileSync(process.execPath, [helper, join(dir, "data")], { encoding: "utf8" })
      .trim()
      .split("\n")
      .map((line) => line.split("\t")[0])
      .sort();

    const expected = held.map((cid) => keyOf(store.get(cid)!)).sort();
    expect(seen).toEqual(expected);
    expect(seen).not.toContain(keyOf("a"));
  });
});

describe("json content", () => {
  it("writes the canonical text it names, with sorted keys and no insignificant whitespace", () => {
    const store = CidStore.inMemory();
    const cid = store.putJson({ b: 2, a: { y: [1, 2], x: null }, c: "three" });

    expect(store.get(cid)).toBe('{"a":{"x":null,"y":[1,2]},"b":2,"c":"three"}');
    expect(cid).toBe(cidV1Raw('{"a":{"x":null,"y":[1,2]},"b":2,"c":"three"}'));
  });

  it("gives the same id to objects written in different key orders", () => {
    const store = CidStore.inMemory();
    const a = store.putJson({ b: 2, a: 1, nested: { z: true, y: null } });
    const b = store.putJson({ a: 1, nested: { y: null, z: true }, b: 2 });

    expect(b).toBe(a);
    expect(store.stats().entries).toBe(1);
    expect(store.getJson(a)).toEqual({ b: 2, a: 1, nested: { z: true, y: null } });
  });

  it("keeps array order, because a list of test results is not a set", () => {
    const store = CidStore.inMemory();
    const cid = store.putJson({ results: ["pass", "fail", "skip"] });

    expect(store.getJson<{ results: string[] }>(cid)!.results).toEqual(["pass", "fail", "skip"]);
    expect(store.putJson({ results: ["skip", "fail", "pass"] })).not.toBe(cid);
  });

  it("round-trips a run-shaped object and drops the field JSON would drop", () => {
    const artifact = {
      schemaVersion: "1.0.0",
      trialId: 12,
      durationMs: 1500.5,
      testResults: [{ name: "adds", status: "pass", durationMs: 42 }],
      note: undefined,
    };
    const canonical =
      '{"durationMs":1500.5,"schemaVersion":"1.0.0","testResults":[{"durationMs":42,"name":"adds","status":"pass"}],"trialId":12}';
    const store = CidStore.inMemory();
    const cid = store.putJson(artifact);

    expect(store.get(cid)).toBe(canonical);
    expect(cid).toBe(cidV1Raw(canonical));
    expect(store.getJson<Record<string, unknown>>(cid)!.trialId).toBe(12);
    expect(store.get(cid)).not.toContain("note");
  });

  it("refuses values JSON cannot hold instead of storing a lossy one", () => {
    const store = CidStore.inMemory();
    expect(() => store.putJson(Number.NaN)).toThrow();
    expect(() => store.putJson(10n)).toThrow();
    expect(() => store.putJson(new Uint8Array([1, 2]))).toThrow();
    const cyclic: Record<string, unknown> = { name: "loop" };
    cyclic.self = cyclic;
    expect(() => store.putJson(cyclic)).toThrow();
    expect(store.stats().entries).toBe(0);
  });

  it("returns null for json that was never stored", () => {
    expect(CidStore.inMemory().getJson(cidV1Raw("absent"))).toBe(null);
  });
});
