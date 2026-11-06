import { describe, expect, it } from "vitest";
import {
  STEP_COPY,
  asReproduction,
  copyFor,
  detailEntries,
  shown,
  toneFor,
} from "@/lib/reproduce/view";

/**
 * The reproduction page's rules, tested where they live.
 *
 * `apps/web` has no React renderer in its test suite — a component test here would need one
 * invented, and an invented harness tests its own invention. So the page's *decisions* (what a
 * missing value looks like, which tone a result selects, what is worth printing at all) are in
 * `lib/reproduce/view.ts`, and this file is why they are there.
 */

describe("an unknown is not a zero", () => {
  it("renders every absence as an em dash", () => {
    expect(shown(null)).toBe("—");
    expect(shown(undefined)).toBe("—");
    expect(shown("")).toBe("—");
  });

  /**
   * The whole point of the split.
   *
   * A reproduction that says "tests claimed: 0" is reporting that the artifact claims nothing
   * passed. A reproduction that says "tests claimed: —" is reporting that the field is not there.
   * Print them identically and the page has accused a runner of a zero score for a payload shape.
   */
  it("renders a real zero as zero, and never as a dash", () => {
    expect(shown(0)).toBe("0");
    expect(shown(false)).toBe("no");
    expect(shown(true)).toBe("yes");
  });

  it("groups a count without inventing precision the record does not have", () => {
    expect(shown(1234)).toBe("1,234");
    expect(shown("0xabc")).toBe("0xabc");
  });

  it("shows an object rather than dropping the row it cannot name", () => {
    expect(shown({ a: 1 })).toBe('{"a":1}');
  });
});

describe("tone is chosen by the result, never typed in", () => {
  it("offers exactly the two meanings a binding can have", () => {
    expect(toneFor(true)).toBe("quench");
    expect(toneFor(false)).toBe("sear");
  });

  /**
   * The design system's tone vocabulary is a fixed set of names in `base.css`, and a component
   * that invents one gets no colour and no warning — a silent styling failure is still a styling
   * failure. Whatever the caller passes, the answer has to be a token that exists.
   */
  it("can never emit a tone the stylesheet has not defined", () => {
    const KNOWN = new Set(["ember", "gold", "quench", "sear", "faint", "dim", "ash", "hot", "text"]);
    for (const value of [true, false]) {
      expect(KNOWN.has(toneFor(value))).toBe(true);
    }
  });
});

describe("what a visitor is actually told", () => {
  /**
   * `reproduce.ts` emits these five names, and the page has copy for each. A sixth binding
   * arriving without copy would render its raw slug (`artifact-hash`) as a heading — which is why
   * the list is asserted rather than trusted to have been kept in step.
   */
  it("has plain words for every binding the endpoint performs", () => {
    expect(Object.keys(STEP_COPY).sort()).toEqual(
      ["artifact-hash", "disclosure", "manifest", "report", "signature"].sort(),
    );
    for (const [name, copy] of Object.entries(STEP_COPY)) {
      expect(copy.title, name).not.toBe(name);
      expect(copy.title.length, name).toBeGreaterThan(10);
      expect(copy.asking.length, name).toBeGreaterThan(10);
    }
  });

  it("degrades to the slug rather than rendering nothing when a name is unknown", () => {
    expect(copyFor("brand-new-binding")).toEqual({ title: "brand-new-binding", asking: "" });
  });

  /**
   * Unlabelled fields are not printed. The alternative — `Object.entries` straight onto the page —
   * turns every API addition into unreviewed user-facing copy, which is how `sigDeadline` would
   * arrive as the word "sigDeadline" in front of a customer.
   */
  it("prints only the fields that were decided to be worth showing", () => {
    const entries = detailEntries({
      artifactCid: "bafkrei…",
      internalScratchpad: { big: "object" },
      claimedTests: 0,
      claimedPassed: null,
    });
    expect(entries.map(([label]) => label)).toEqual(["artifact", "tests claimed", "passed claimed"]);
    // And the zero survived the trip, while the missing value became a dash.
    expect(entries.map(([, value]) => value)).toEqual(["bafkrei…", "0", "—"]);
  });
});

describe("the response is shape-checked, not second-schema'd", () => {
  const good = {
    trialId: 14,
    reproduced: true,
    steps: [{ name: "disclosure", passed: true, detail: { runHash: "0x…" } }],
    chain: { chainId: 31337 },
  };

  it("accepts a well-formed reproduction", () => {
    expect(asReproduction(good)).toEqual(good);
  });

  /**
   * Each rejection is a different way a body can be wrong, and every one of them has to end in
   * "the page says it could not read this", not in a half-rendered list. A page that rendered
   * `steps` as optional would show "This run reproduces." over zero bindings.
   */
  it("refuses every malformed shape rather than rendering part of one", () => {
    expect(asReproduction(null)).toBeNull();
    expect(asReproduction("0x")).toBeNull();
    expect(asReproduction({ ...good, trialId: "14" })).toBeNull();
    expect(asReproduction({ ...good, reproduced: "true" })).toBeNull();
    expect(asReproduction({ ...good, steps: null })).toBeNull();
    expect(asReproduction({ ...good, steps: [{ name: "disclosure" }] })).toBeNull();
    expect(asReproduction({ ...good, steps: [{ name: "x", passed: true }] })).toBeNull();
    expect(asReproduction({ ...good, chain: null })).toBeNull();
    // A step carrying a non-string failure would crash the render that prints it.
    expect(asReproduction({ ...good, steps: [{ name: "x", passed: false, detail: {}, failure: 7 }] })).toBeNull();
  });

  it("accepts a failed binding with no reason text, because absence of a reason is legal", () => {
    const payload = { ...good, reproduced: false, steps: [{ name: "report", passed: false, detail: {} }] };
    expect(asReproduction(payload)).not.toBeNull();
  });
});
