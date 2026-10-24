import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { canonicalize } from "json-canonicalize";
import { keccak256, stringToHex } from "viem";
import {
  GENESIS,
  SPAN_ACTORS,
  SPAN_INVENTORY,
  TraceError,
  TraceLog,
  verifyEntries,
  type SealedSpan,
} from "../src/trace.js";

/**
 * The trace spine's only real guarantee is that a reader can detect a lie.
 *
 * So these tests do not assert that `append` returns something with a hash on it. They
 * recompute the chain the way a reader would — canonical JSON, keccak, link by link — and
 * they make the specific lies a tamperer would tell: edit an entry, move one, cut the tail
 * off, crash mid-write. Each is either detected at a named index or documented as
 * undetectable, and the difference is asserted rather than assumed.
 */

let dir: string;

beforeAll(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "crucible-trace-"));
});

afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

function file(name: string): string {
  return path.join(dir, name);
}

/** What an independent reader does: recompute one link from the bytes on disk. */
function recompute(entry: SealedSpan): string {
  const { hash: _hash, ...body } = entry;
  return keccak256(stringToHex(canonicalize(body)));
}

describe("chaining", () => {
  it("links each entry to the one before it, starting from a zero hash", async () => {
    const log = await TraceLog.open(file("chain.jsonl"), { now: () => 1_700_000_000_000 });
    const first = await log.appendNow({ span: "keeper.sweep", actor: "keeper", trialId: 1 });
    const second = await log.appendNow({ span: "keeper.act", actor: "keeper", trialId: 1 });

    expect(first.prevHash).toBe(GENESIS);
    expect(second.prevHash).toBe(first.hash);
    expect(first.hash).toBe(recompute(first));
    expect(second.hash).toBe(recompute(second));

    const check = await log.verify();
    expect(check).toEqual({ ok: true, entries: 2, head: second.hash });
  });

  it("hashes the canonical form, so key order does not change the hash", async () => {
    const log = TraceLog.memory({ now: () => 5 });
    const a = await log.append({
      ts: 5,
      span: "x",
      detail: { alpha: 1, beta: 2 },
    });
    const b = await TraceLog.memory({ now: () => 5 }).append({
      ts: 5,
      span: "x",
      detail: { beta: 2, alpha: 1 },
    });
    expect(a.hash).toBe(b.hash);
  });

  it("resumes a chain instead of forking it", async () => {
    const f = file("resume.jsonl");
    const first = await TraceLog.open(f);
    const a = await first.appendNow({ span: "a" });

    // A second process opening the same file must continue from its head. If it started
    // from GENESIS again, the file would verify as broken at the handover.
    const second = await TraceLog.open(f);
    expect(second.head).toBe(a.hash);
    const b = await second.appendNow({ span: "b" });
    expect(b.prevHash).toBe(a.hash);

    const check = await second.verify();
    expect(check.ok).toBe(true);
    if (check.ok) expect(check.entries).toBe(2);
  }, 20_000);

  it("serializes concurrent appends into one valid chain", async () => {
    const log = await TraceLog.open(file("concurrent.jsonl"));
    const sealed = await Promise.all(
      Array.from({ length: 50 }, (_, i) => log.appendNow({ span: "burst", trialId: i })),
    );
    // Every returned entry must be a distinct link, not fifty forks of one parent.
    expect(new Set(sealed.map((s) => s.hash)).size).toBe(50);
    for (let i = 1; i < sealed.length; i++) {
      expect(sealed[i]!.prevHash).toBe(sealed[i - 1]!.hash);
    }
    const check = await log.verify();
    expect(check.ok).toBe(true);
  }, 20_000);
});

describe("detecting a lie", () => {
  it("catches an edited entry and names its index", async () => {
    const f = file("edited.jsonl");
    const log = await TraceLog.open(f);
    for (let i = 0; i < 4; i++) await log.appendNow({ span: "step", trialId: i });

    const lines = (await readFile(f, "utf8")).trim().split("\n");
    const entry = JSON.parse(lines[2]!) as SealedSpan;
    entry.detail = { rewritten: true };
    lines[2] = JSON.stringify(entry);
    await writeFile(f, lines.join("\n") + "\n", "utf8");

    const check = await TraceLog.open(f).then(() => null).catch((err) => err as Error);
    expect(check).toBeInstanceOf(TraceError);
    expect(String(check)).toMatch(/does not verify \(entry 2/);
  }, 20_000);

  it("catches two entries swapped in place", async () => {
    const f = file("swapped.jsonl");
    const log = await TraceLog.open(f);
    for (let i = 0; i < 3; i++) await log.appendNow({ span: "step", trialId: i });

    const lines = (await readFile(f, "utf8")).trim().split("\n");
    [lines[0], lines[1]] = [lines[1]!, lines[0]!];
    await writeFile(f, lines.join("\n") + "\n", "utf8");

    const entries = (await readFile(f, "utf8"))
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l) as SealedSpan);
    const check = verifyEntries(entries);
    expect(check.ok).toBe(false);
    if (!check.ok) expect(check.index).toBe(0);
  }, 20_000);

  it("refuses to append to a broken chain rather than laundering the break", async () => {
    const f = file("launder.jsonl");
    const log = await TraceLog.open(f);
    await log.appendNow({ span: "one" });
    await log.appendNow({ span: "two" });

    const lines = (await readFile(f, "utf8")).trim().split("\n");
    const first = JSON.parse(lines[0]!) as SealedSpan;
    first.detail = "altered";
    lines[0] = JSON.stringify(first);
    await writeFile(f, lines.join("\n") + "\n", "utf8");

    await expect(TraceLog.open(f)).rejects.toThrow(/Refusing to append to a broken chain/);
  }, 20_000);

  /**
   * The limit, stated as a test so nobody discovers it as a surprise.
   *
   * Cutting entries off the end leaves a shorter chain that is entirely valid. Detecting
   * that needs the head anchored somewhere the writer does not control, which nothing does
   * yet — so this asserts the limitation is real rather than pretending the chain is
   * complete when it is not.
   */
  it("cannot detect a truncated tail, and says so", async () => {
    const f = file("truncated.jsonl");
    const log = await TraceLog.open(f);
    for (let i = 0; i < 3; i++) await log.appendNow({ span: "step", trialId: i });

    const lines = (await readFile(f, "utf8")).trim().split("\n");
    await writeFile(f, [lines[0], lines[1]].join("\n") + "\n", "utf8");

    const check = verifyEntries(
      ((await readFile(f, "utf8")).trim().split("\n")).map((l) => JSON.parse(l) as SealedSpan),
    );
    expect(check.ok).toBe(true);
    if (check.ok) expect(check.entries).toBe(2);
  }, 20_000);

  it("distinguishes a crash-truncated last line from a mid-file edit", async () => {
    const f = file("crash.jsonl");
    const log = await TraceLog.open(f);
    await log.appendNow({ span: "one" });
    await writeFile(f, (await readFile(f, "utf8")) + '{"ts":1,"span":"two","pre', "utf8");

    await expect(TraceLog.open(f)).rejects.toThrow(/cut off by a crash/);
  }, 20_000);
});

describe("what a span may carry", () => {
  it("refuses a bigint by name, instead of sealing bytes JSON would change", async () => {
    const log = TraceLog.memory();
    await expect(
      log.append({ ts: 1, span: "x", detail: { rewardWei: 10n ** 18n } }),
    ).rejects.toThrow(/detail\.rewardWei is a bigint/);
    // The failed append must not have advanced the chain.
    expect(log.size).toBe(0);
  });

  it("refuses undefined and non-finite numbers", async () => {
    const log = TraceLog.memory();
    await expect(log.append({ ts: 1, span: "x", detail: { a: undefined } })).rejects.toThrow(
      /detail\.a is undefined/,
    );
    await expect(log.append({ ts: 1, span: "x", detail: { a: NaN } })).rejects.toThrow(
      /only finite numbers/,
    );
  });

  it("accepts a plain string detail and a nested structure", async () => {
    const log = TraceLog.memory({ now: () => 1 });
    const a = await log.append({ ts: 1, span: "x", detail: "a sentence" });
    const b = await log.append({ ts: 1, span: "y", detail: { n: 3, deep: { ok: true } } });
    expect(a.hash).toMatch(/^0x[0-9a-f]{64}$/);
    expect(b.prevHash).toBe(a.hash);
  });
});

describe("span inventory", () => {
  // The showcase renders spans it did not witness. An entry here that misdescribes its
  // span is a page that asserts something the chain did not say, so the table itself is
  // gated: every name dotted and namespaced, every actor a known writer, every detail
  // key list present and non-empty.
  it("is well-formed — dotted names, known actors, non-empty detail lists", () => {
    expect(Object.keys(SPAN_INVENTORY).length).toBeGreaterThan(0);
    for (const [name, spec] of Object.entries(SPAN_INVENTORY)) {
      expect(name, "span names are dotted namespaces").toMatch(/^[a-z]+(\.[a-z-]+)+$/);
      expect(SPAN_ACTORS, `${name} actor`).toContain(spec.actor);
      expect(spec.meaning.length, `${name} says when it is written`).toBeGreaterThan(0);
      expect(spec.detail.length, `${name} declares its detail keys`).toBeGreaterThan(0);
      for (const key of spec.detail) {
        expect(key, `${name} detail key`).toMatch(/^[a-z][a-zA-Z0-9]*$/);
      }
    }
  });

  it("carries the spans the keeper actually emits", () => {
    for (const name of ["keeper.start", "keeper.sweep", "keeper.act"]) {
      expect(SPAN_INVENTORY[name], `${name} is inventoried`).toBeDefined();
      expect(SPAN_INVENTORY[name]!.actor).toBe("keeper");
    }
  });
});

