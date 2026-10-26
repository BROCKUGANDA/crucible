import { describe, expect, it } from "vitest";
import { splitBank, verifyPartition, isHoldout, type ProbeRecord } from "../src/splits.js";

function probe(id: string, verdict: "PASS" | "VOID" | "FAIL" = "PASS"): ProbeRecord {
  return { probeId: id, prompt: `prompt ${id}`, expectedVerdict: verdict };
}

describe("splits (gate 726)", () => {
  it("splits bank into train/dev/holdout deterministically", () => {
    const bank = Array.from({ length: 1000 }, (_, i) => probe(`probe-${i}`));
    const split = splitBank(bank);

    expect(split.train.length + split.dev.length + split.holdout.length).toBe(1000);
    expect(verifyPartition(bank, split)).toBe(true);
  });

  it("is order-independent", () => {
    const bank = Array.from({ length: 500 }, (_, i) => probe(`probe-${i}`));
    const forward = splitBank(bank);
    const backward = splitBank([...bank].reverse());

    expect(forward.train.map((p) => p.probeId).sort()).toEqual(backward.train.map((p) => p.probeId).sort());
    expect(forward.dev.map((p) => p.probeId).sort()).toEqual(backward.dev.map((p) => p.probeId).sort());
    expect(forward.holdout.map((p) => p.probeId).sort()).toEqual(backward.holdout.map((p) => p.probeId).sort());
  });

  it("is reproducible across runs", () => {
    const bank = Array.from({ length: 300 }, (_, i) => probe(`stable-${i}`));
    const a = splitBank(bank);
    const b = splitBank(bank);
    expect(a).toEqual(b);
  });

  it("holdout is the verdict bank — never trained on", () => {
    const bank = Array.from({ length: 1000 }, (_, i) => probe(`h-${i}`));
    const split = splitBank(bank);
    for (const p of split.holdout) {
      expect(isHoldout(p.probeId)).toBe(true);
    }
    for (const p of split.train) {
      expect(isHoldout(p.probeId)).toBe(false);
    }
    for (const p of split.dev) {
      expect(isHoldout(p.probeId)).toBe(false);
    }
  });

  it("handles empty bank", () => {
    const split = splitBank([]);
    expect(split.train).toEqual([]);
    expect(split.dev).toEqual([]);
    expect(split.holdout).toEqual([]);
  });
});
