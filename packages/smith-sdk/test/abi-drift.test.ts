import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { keccak256, toHex } from "viem";
import { ALLOY_ABI, TEAM_LEDGER_ABI, TRIALS_ABI } from "../src/abi.js";
import { ARENA_ABI } from "../src/arena-abi.js";

/**
 * The ABI is hand-written, and a hand-written ABI drifts.
 *
 * `AgentRegistered` drifted first: the Solidity source declares
 * `(agentId, operator, runner, metadataURI, stake)` and the ABI had the last two swapped.
 * A wrong parameter ORDER changes the topic0 digest, so every `AgentRegistered` log on a
 * real chain silently decoded as an unknown event. The read model then had no agents, the
 * hall filtered on `wins > 0`, and `/hall` answered `[]` on a chain that had settled four
 * trials — a correct-looking empty rather than an error.
 *
 * This test compares the ABI against the .sol source, which is committed and needs no
 * compiler, so it runs in the JS job with nothing built.
 */

const SOURCES = [
  { file: "CrucibleTrials.sol", abi: TRIALS_ABI },
  { file: "AlloyRegistry.sol", abi: ALLOY_ABI },
  { file: "Arena.sol", abi: ARENA_ABI },
  { file: "TeamLedger.sol", abi: TEAM_LEDGER_ABI },
] as const;

/** Solidity encodes an enum as its smallest unsigned int; the contracts' enums all fit in one byte. */
const ENUMS = new Set(["Verdict", "Status", "Outcome", "BreakKind", "Vote"]);

interface SourceEvent {
  name: string;
  signature: string;
  indexed: boolean[];
}

function solidityType(rawType: string): string {
  const t = rawType.replace(/\s+/g, " ").trim();
  if (ENUMS.has(t)) return "uint8";
  const match = t.match(/^([A-Za-z0-9_]+)\s*(\[[^\]]*\])?$/);
  if (!match) throw new Error(`unhandled solidity type in an event: "${rawType}"`);
  const [, base, array = ""] = match;
  if (!array) return base;
  // `T[]` is `T[1]` for the signature hash; a fixed length is kept as written.
  const len = array.match(/\[(\d*)\]/)?.[1];
  return `${base}[${len ?? ""}]`;
}

function parseSource(path: string): SourceEvent[] {
  const src = readFileSync(path, "utf8");
  const events: SourceEvent[] = [];

  for (const [, name, params] of src.matchAll(/event\s+([A-Za-z0-9_]+)\s*\(([^)]*)\)\s*;/g)) {
    if (!params.trim()) continue;
    const indexed: boolean[] = [];
    const types = params.split(",").map((p) => {
      const tokens = p.trim().replace(/calldata|memory|indexed/g, " ").replace(/\s+/g, " ").trim();
      indexed.push(/\bindexed\b/.test(p));
      const type = tokens.split(" ")[0];
      if (!type) throw new Error(`could not read a type from event param "${p}"`);
      return solidityType(type);
    });
    events.push({ name, signature: `${name}(${types.join(",")})`, indexed });
  }
  return events;
}

function abiSignature(item: (typeof TRIALS_ABI)[number]): string {
  const event = item as Extract<typeof item, { type: "event" }>;
  return `${event.name}(${event.inputs.map((i) => i.type).join(",")})`;
}

describe("TRIALS_ABI against the Solidity source", () => {
  for (const { file, abi } of SOURCES) {
    const path = fileURLToPath(new URL(`../../../crucible-contracts/contracts/${file}`, import.meta.url));
    const declared = parseSource(path);
    const inAbi = abi.filter((i) => i.type === "event");

    it(`${file}: every event the ABI claims exists in the source`, () => {
      const names = new Set(declared.map((e) => e.name));
      const invented = inAbi.map((i) => (i as { name: string }).name).filter((n) => !names.has(n));
      expect(invented).toEqual([]);
    });

    it(`${file}: each ABI event matches the source signature and indexed flags exactly`, () => {
      for (const item of inAbi) {
        const event = item as Extract<(typeof TRIALS_ABI)[number], { type: "event" }>;
        const source = declared.find((e) => e.name === event.name);
        expect(source, `${event.name} is not declared in ${file}`).toBeDefined();
        expect(abiSignature(item), `${event.name} parameter types or order`).toBe(source!.signature);
        expect(event.inputs.map((i) => Boolean(i.indexed)), `${event.name} indexed flags`).toEqual(
          source!.indexed,
        );
      }
    });

    it(`${file}: every event the source emits is present in the ABI`, () => {
      // The other three checks all read ABI -> source, so they prove the ABI invents nothing and
      // say nothing about what it OMITS. An event missing here is not an error anywhere: the log
      // filter built from this ABI simply never matches it, the ingest list that names it is
      // silently short one, and a decoder reports the live log as undecodable. Measured on the
      // deployed chain 2026-10-24: four `VerificationReceiptMinted` logs — one per settled trial,
      // the receipts the verify page exists to show — came back unnameable, and `RunnerSet` was in
      // the indexer's own EVENT_NAMES while having no ABI entry to match it, so that case had never
      // run in production. Both directions are the gate.
      const abiNames = new Set(inAbi.map((i) => (i as { name: string }).name));
      const missing = declared.map((e) => e.name).filter((n) => !abiNames.has(n));
      expect(missing, `${file}: events the ABI does not carry`).toEqual([]);
    });

    it(`${file}: topic0 of every ABI event is the source's own digest`, () => {
      for (const item of inAbi) {
        const source = declared.find((e) => e.name === (item as { name: string }).name)!;
        const fromAbi = keccak256(toHex(abiSignature(item)));
        expect(fromAbi, `${source.name} topic0`).toBe(keccak256(toHex(source.signature)));
      }
    });
  }

  it("indexes the events the hall proof is built from", () => {
    // VerdictFinalized is the settlement receipt and IdentityLinked the ERC-8004 link. If
    // either ever stops decoding, the hall goes quiet without throwing, so the two events
    // the leaderboard is made of are named here as well as in the ABI.
    const names = TRIALS_ABI.filter((i) => i.type === "event").map((i) => i.name);
    expect(names).toContain("VerdictFinalized");
    expect(names).toContain("IdentityLinked");
    expect(names).toContain("AgentRegistered");
  });
});

/**
 * A struct's field order is part of its ABI.
 *
 * `AlloyRegistry.records` is a public mapping of a struct, so its getter returns the
 * struct's fields in DECLARATION ORDER, and viem hands a multi-output result back as an
 * array. Reading the tier is therefore reading index 3 of that array — a position that
 * means nothing except "where the tier used to be".
 *
 * If a field were ever inserted into `Record`, the array would shift and index 3 would
 * hold a different field: a number that was never measured as a tier, published as one.
 * The API side already avoids this by reading `tierOf(agentId)` on its own; the SDK's
 * `alloyRecord` is positional, and this is what keeps that honest.
 *
 * The struct is read from the committed `.sol` source, so the test needs no compiler.
 */
function parseStructFields(source: string, structName: string): { name: string; type: string }[] {
  const body = new RegExp(`struct\\s+${structName}\\s*\\{([^}]*)\\}`, "s").exec(source);
  if (!body?.[1]) throw new Error(`struct ${structName} is not declared in the source`);
  return body[1]
    // `// …` is stripped before splitting, because a packed struct is exactly the kind of
    // declaration that carries a comment per field — AlloyRegistry's Record says which figures are
    // the epoch window and which are the lifetime book, and the first version of this parser read
    // "// current epoch\n uint32 survived" as one field and threw. Stripping the comment keeps the
    // documentation and the gate; the fields themselves are still matched strictly, so a real
    // syntax surprise fails rather than parses.
    .replace(/\/\/[^\n]*/g, "")
    .split(";")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const match = /^([A-Za-z_][A-Za-z0-9_]*)\s+([A-Za-z_][A-Za-z0-9_]*)$/.exec(line);
      if (!match) throw new Error(`could not read a field of struct ${structName}: "${line}"`);
      return { type: match[1]!, name: match[2]! };
    });
}

describe("ALLOY_ABI's struct getters against the Solidity source", () => {
  const path = fileURLToPath(new URL("../../../crucible-contracts/contracts/AlloyRegistry.sol", import.meta.url));
  const source = readFileSync(path, "utf8");

  it("declares records' outputs in the struct's own field order", () => {
    const declared = parseStructFields(source, "Record");
    const records = ALLOY_ABI.find((i) => i.type === "function" && i.name === "records");
    if (!records || records.type !== "function") throw new Error("ALLOY_ABI has no records() function");

    expect(
      records.outputs.map((o) => `${o.type} ${o.name}`),
      "records() outputs are read by position, so their order must be the struct's order",
    ).toEqual(declared.map((f) => `${f.type} ${f.name}`));
  });

  it("puts the tier where the readers expect it", () => {
    // The three counters, then the tier, then ADR-0012's epoch book. A test that names every index
    // makes a reorder a deliberate change rather than an accident, and it is the reason the five
    // appended fields are safe to read positionally anywhere else.
    const records = ALLOY_ABI.find((i) => i.type === "function" && i.name === "records");
    if (!records || records.type !== "function") throw new Error("ALLOY_ABI has no records() function");
    expect(records.outputs.map((o) => o.name)).toEqual([
      "wins",
      "survived",
      "slashes",
      "tier",
      "epoch",
      "lifetimeWins",
      "lifetimeSlashes",
      "holder",
      "epochStartedAt",
    ]);
  });

  it("reads a struct field that carries a trailing comment", () => {
    // The parser used to throw on `uint32 wins; // current epoch`, which is how a packed struct gets
    // documented here. Proved against a fixture rather than asserted in prose: if the comment strip
    // is removed, this fails and the real `Record` check goes with it.
    const fields = parseStructFields("struct S {\n  uint32 a; // one\n  // two\n  uint8 b;\n}", "S");
    expect(fields).toEqual([
      { type: "uint32", name: "a" },
      { type: "uint8", name: "b" },
    ]);
    expect(() => parseStructFields("struct S {\n  uint32 a = 1;\n}", "S")).toThrow(/could not read/);
  });
});
