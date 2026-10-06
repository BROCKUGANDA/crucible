import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { keccak256, toHex } from "viem";
import { ALLOY_ABI, TRIALS_ABI } from "../src/abi.js";

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
] as const;

/** Solidity encodes an enum as its smallest unsigned int; the contracts' enums all fit in one byte. */
const ENUMS = new Set(["Verdict", "Status"]);

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
