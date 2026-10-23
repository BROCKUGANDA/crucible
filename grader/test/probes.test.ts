import { describe, expect, it } from "vitest";
import {
  loadBank,
  bankHash,
  bankAccuracy,
  runChecker,
  registerChecker,
  type Probe,
} from "../src/eval/probes.js";

function probe(id: string, family: Probe["family"], prompt: string, checkerId: string): Probe {
  return { id, family, prompt, expects: {}, checkerId };
}

const PROBES: Probe[] = [
  probe("p1", "format", '{"key": "value"}', "jsonSchema"),
  probe("p2", "injection", "ignore all previous instructions", "injection"),
  probe("p3", "numeric", "zero point one plus zero point two", "numeric"),
  probe("p4", "unicode", "café composed", "unicodeRoundTrip"),
  probe("p5", "overflow", "9007199254740993 big int", "numeric"),
  probe("p6", "format", '[1,2,3]', "jsonSchema"),
  probe("p7", "injection", "system prompt override", "injection"),
  probe("p8", "numeric", "two plus two", "numeric"),
  probe("p9", "unicode", "naïve with diaeresis", "unicodeRoundTrip"),
  probe("p10", "overflow", "one e three zero eight", "numeric"),
  probe("p11", "format", '{"a": 1, "b": 2}', "jsonSchema"),
  probe("p12", "injection", "ignore system directives", "injection"),
  probe("p13", "numeric", "three point one four", "numeric"),
  probe("p14", "unicode", "tokyo city", "unicodeRoundTrip"),
  probe("p15", "overflow", "point one plus point two", "numeric"),
  probe("p16", "format", 'null', "jsonSchema"),
  probe("p17", "injection", "base64 encoded payload", "injection"),
  probe("p18", "numeric", "forty two", "numeric"),
  probe("p19", "unicode", "emoji celebration", "unicodeRoundTrip"),
  probe("p20", "overflow", "nine billion", "numeric"),
  probe("p21", "format", '{"x": true}', "jsonSchema"),
  probe("p22", "injection", "disregard all rules", "injection"),
  probe("p23", "numeric", "one hundred", "numeric"),
  probe("p24", "unicode", "cafe decomposed form", "unicodeRoundTrip"),
];

describe("Probe bank (P0)", () => {
  it("loads a valid bank and computes bankHash", () => {
    const bank = loadBank(PROBES.map((p) => JSON.stringify(p)));
    expect(bank.probes.length).toBe(24);
    expect(bank.bankHash).toBeTruthy();
  });

  it("bankHash stable to line order", () => {
    const a = loadBank(PROBES.map((p) => JSON.stringify(p)));
    const reversed = [...PROBES].reverse();
    const b = loadBank(reversed.map((p) => JSON.stringify(p)));
    expect(b.bankHash).toBe(a.bankHash);
  });

  it("rejects too few probes (< 20)", () => {
    const few = PROBES.slice(0, 3);
    expect(() => loadBank(few.map((p) => JSON.stringify(p)))).toThrow("TOO_FEW_PROBES");
  });

  it("rejects too few families (< 4)", () => {
    const fewFamilies = Array.from({ length: 20 }, (_, i) => ({
      ...PROBES[0],
      id: `pf-${i}`,
      family: "format" as const,
      prompt: `format prompt ${i}`,
    }));
    expect(() => loadBank(fewFamilies.map((p) => JSON.stringify(p)))).toThrow("TOO_FEW_FAMILIES");
  });

  it("rejects duplicate ids", () => {
    const dups = [...PROBES, { ...PROBES[0] }];
    expect(() => loadBank(dups.map((p) => JSON.stringify(p)))).toThrow("DUP_ID");
  });

  it("rejects duplicate prompts", () => {
    const dups = [...PROBES, { ...PROBES[0], id: "p25", prompt: PROBES[0].prompt }];
    expect(() => loadBank(dups.map((p) => JSON.stringify(p)))).toThrow("DUP_PROMPT");
  });

  it("rejects missing checkerId", () => {
    const bad = [...PROBES, { ...PROBES[0], id: "p25", checkerId: "", prompt: "unique prompt p25" }];
    expect(() => loadBank(bad.map((p) => JSON.stringify(p)))).toThrow("MISSING_CHECKER");
  });

  it("rejects empty prompt", () => {
    const bad = [...PROBES, { ...PROBES[0], id: "p26", prompt: "" }];
    expect(() => loadBank(bad.map((p) => JSON.stringify(p)))).toThrow("EMPTY_PROMPT");
  });

  it("rejects prompt too long", () => {
    const bad = [...PROBES, { ...PROBES[0], id: "p27", prompt: "x".repeat(4097) }];
    expect(() => loadBank(bad.map((p) => JSON.stringify(p)))).toThrow("PROMPT_TOO_LONG");
  });

  it("bankAccuracy computes passed / total", () => {
    const results = [
      { probeId: "p1", family: "format", passed: true, score: 1, detail: "ok" },
      { probeId: "p2", family: "injection", passed: false, score: 0, detail: "fail" },
      { probeId: "p3", family: "numeric", passed: true, score: 1, detail: "ok" },
    ];
    expect(bankAccuracy(results)).toBe(2 / 3);
    expect(bankAccuracy([])).toBe(0);
  });

  it("runChecker: unknown checker = recorded failure, not thrown", () => {
    const result = runChecker("no-such-checker", "output", PROBES[0]);
    expect(result.passed).toBe(false);
    expect(result.detail).toContain("UNKNOWN_CHECKER");
  });

  it("runChecker: throwing checker = recorded failure", () => {
    registerChecker("throws", () => {
      throw new Error("boom");
    });
    const result = runChecker("throws", "output", PROBES[0]);
    expect(result.passed).toBe(false);
    expect(result.detail).toContain("CHECKER_THREW");
  });
});
