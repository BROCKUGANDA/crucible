import { describe, expect, it } from "vitest";
import { siteIndex } from "@crucible/site-index";
import {
  MAX_DETAIL_CHARS,
  MAX_SPOKEN_CHARS,
  parseEnvelope,
  spokenWindow,
} from "../src/frenchy/envelope.js";
import { FRENCHY_SYSTEM_PROMPT } from "../src/frenchy/prompt.js";

/**
 * The envelope, and the gate behind it.
 *
 * The model is asked for one JSON object with three parts: what to say, what
 * to show, and what to do. Two of the three are harmless - a string is a
 * string. The third is the one that can do something to the visitor's screen,
 * so it is the one these tests are about: a path that is not a page of this
 * site is refused, a point that is not on the page is refused, and a refusal
 * is a refusal rather than a repair.
 *
 * The refusal is recorded rather than swallowed, because a model that keeps
 * asking for a page that does not exist is a model whose prompt is out of
 * date, and that is worth an operator seeing.
 */

const good = (over: Record<string, unknown> = {}) =>
  JSON.stringify({
    spoken: "Three trials are open. Shall I take you to the board?",
    detail: "#12 - judging - 0.4 ETH",
    action: { kind: "navigate", path: "/trials", why: "the open trials" },
    ...over,
  });

describe("reading the answer", () => {
  it("reads the three parts", () => {
    const { answer } = parseEnvelope(good());
    expect(answer?.spoken).toContain("Three trials are open");
    expect(answer?.detail).toBe("#12 - judging - 0.4 ETH");
    expect(answer?.action).toEqual({
      kind: "navigate",
      path: "/trials",
      why: "the open trials",
    });
  });

  it("reads an answer with no detail and no action", () => {
    const { answer } = parseEnvelope(
      JSON.stringify({ spoken: "The fee is five percent of the payout." }),
    );
    expect(answer?.spoken).toBe("The fee is five percent of the payout.");
    expect(answer?.detail).toBeNull();
    expect(answer?.action).toBeNull();
  });

  it("reads an answer wrapped in a markdown fence", () => {
    const { answer } = parseEnvelope("```json\n" + good() + "\n```");
    expect(answer?.action?.path).toBe("/trials");
  });

  it("falls back to plain text when the model does not answer in the envelope", () => {
    const { answer } = parseEnvelope("The escrow page answers where your ETH is.");
    expect(answer).toBeNull();
  });

  it("falls back when the envelope has no spoken line", () => {
    const { answer } = parseEnvelope(JSON.stringify({ detail: "everything" }));
    expect(answer).toBeNull();
  });

  it("falls back when the envelope is not an object", () => {
    expect(parseEnvelope("[1, 2, 3]").answer).toBeNull();
    expect(parseEnvelope("42").answer).toBeNull();
  });

  it("caps the spoken line at what the voice can carry", () => {
    const { answer } = parseEnvelope(good({ spoken: "x".repeat(2000) }));
    expect(answer?.spoken.length).toBe(MAX_SPOKEN_CHARS);
  });

  it("caps the detail so a page cannot be made to stop responding", () => {
    const { answer } = parseEnvelope(good({ detail: "y".repeat(9000) }));
    expect(answer?.detail?.length).toBe(MAX_DETAIL_CHARS);
  });

  it("resolves a newline the model double-escaped", () => {
    // A model that writes `\\n` inside its JSON meant a newline and got two
    // characters; the visitor should see the line break, not the escape.
    const { answer } = parseEnvelope(
      JSON.stringify({ spoken: "Two things.", detail: "- one\\n- two" }),
    );
    expect(answer?.detail).toBe("- one\n- two");
  });
});

describe("the action gate", () => {
  it("allows a navigate to a page of this site", () => {
    const { answer, refused } = parseEnvelope(good());
    expect(answer?.action?.kind).toBe("navigate");
    expect(refused).toEqual([]);
  });

  it("allows a concrete path that matches a dynamic route", () => {
    const { answer } = parseEnvelope(
      good({ action: { kind: "navigate", path: "/trials/12", why: "that trial" } }),
    );
    expect(answer?.action?.path).toBe("/trials/12");
  });

  it("refuses a path that is not a page of this site", () => {
    const { answer, refused } = parseEnvelope(
      good({ action: { kind: "navigate", path: "/pay-someone", why: "the payment page" } }),
    );
    expect(answer?.action).toBeNull();
    expect(refused.join(" ")).toContain("/pay-someone");
  });

  it("refuses a path that is one segment too deep", () => {
    const { answer } = parseEnvelope(
      good({ action: { kind: "navigate", path: "/trials/12/replay/extra", why: "deeper" } }),
    );
    expect(answer?.action).toBeNull();
  });

  it("allows a point that the page declares", () => {
    const { answer } = parseEnvelope(
      good({
        action: { kind: "point", path: "/trials", point: "trial-table", why: "the table" },
      }),
    );
    expect(answer?.action).toEqual({
      kind: "point",
      path: "/trials",
      point: "trial-table",
      why: "the table",
    });
  });

  it("refuses a point the page does not declare", () => {
    const { answer, refused } = parseEnvelope(
      good({ action: { kind: "point", path: "/trials", point: "hidden-thing", why: "something" } }),
    );
    expect(answer?.action).toBeNull();
    expect(refused.join(" ")).toContain("hidden-thing");
  });

  it("refuses a point action with no point", () => {
    const { answer } = parseEnvelope(good({ action: { kind: "point", path: "/trials", why: "x" } }));
    expect(answer?.action).toBeNull();
  });

  it("refuses a verb that is not navigate or point", () => {
    const { answer, refused } = parseEnvelope(
      good({ action: { kind: "sign", path: "/trials", why: "x" } }),
    );
    expect(answer?.action).toBeNull();
    expect(refused.join(" ")).toContain("sign");
  });

  it("refuses an action with no path", () => {
    const { answer } = parseEnvelope(good({ action: { kind: "navigate", why: "x" } }));
    expect(answer?.action).toBeNull();
  });

  it("keeps the spoken line even when the action is refused", () => {
    // A refusal is about the action, not about the answer: the visitor asked
    // a question and deserves the answer even when the destination is not
    // allowed.
    const { answer } = parseEnvelope(
      good({ action: { kind: "navigate", path: "/nowhere", why: "x" } }),
    );
    expect(answer?.spoken).toContain("Three trials are open");
    expect(answer?.action).toBeNull();
  });

  it("never lets an action through that the site does not have", () => {
    // The whole point of the gate, stated as a property: for every path the
    // model could name that is not a page, the action is dropped.
    for (const path of ["/nope", "/trials/12/replay/extra", "/", "trials"]) {
      const { answer } = parseEnvelope(good({ action: { kind: "navigate", path, why: "x" } }));
      if (path === "/") {
        expect(answer?.action?.path).toBe("/");
        continue;
      }
      expect(answer?.action).toBeNull();
    }
  });
});

describe("the spoken window", () => {
  it("leaves a short answer alone", () => {
    expect(spokenWindow("Short and sweet.")).toBe("Short and sweet.");
  });

  it("cuts at a sentence boundary rather than mid-word", () => {
    const text = `${"a".repeat(400)}. ${"b".repeat(400)}.`;
    const window = spokenWindow(text);
    expect(window.endsWith(".")).toBe(true);
    expect(window.length).toBeLessThanOrEqual(600);
  });

  it("says so when it had to cut mid-sentence", () => {
    const text = "word ".repeat(300);
    const window = spokenWindow(text);
    expect(window.endsWith("…")).toBe(true);
  });
});

describe("the prompt", () => {
  it("carries every route of the site", () => {
    for (const entry of siteIndex) {
      expect(FRENCHY_SYSTEM_PROMPT).toContain(entry.path);
    }
  });

  it("asks for the envelope and names both verbs", () => {
    expect(FRENCHY_SYSTEM_PROMPT).toContain('"spoken"');
    expect(FRENCHY_SYSTEM_PROMPT).toContain('"detail"');
    expect(FRENCHY_SYSTEM_PROMPT).toContain('"action"');
    expect(FRENCHY_SYSTEM_PROMPT).toContain("navigate");
    expect(FRENCHY_SYSTEM_PROMPT).toContain("point");
  });

  it("still forbids signing", () => {
    expect(FRENCHY_SYSTEM_PROMPT).toContain("You NEVER sign transactions");
  });
});
