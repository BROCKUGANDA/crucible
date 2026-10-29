import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { trialIdFromSegment } from "@/lib/trial-id";

/**
 * The soft-404 gate for `/trials/:id`.
 *
 * The 2026-10-29 browser audit found `/trials/999`, `/trials/0` and `/trials/abc` answering
 * **HTTP 200** with the site's "Lost slag." body, because the route was a client component and
 * the data arrives over the snapshot stream after the status line has been sent.
 *
 * Two separate claims are held here, and they are deliberately different in kind:
 *
 *   1. the *predicate* — pure, so the arithmetic that justifies a 404 is checked rather than
 *      asserted by a comment;
 *   2. the *wiring* — that the route module actually calls `notFound()` with that predicate, and
 *      that it is a server module. This is the half that a refactor can silently undo, so it is
 *      read out of the file that runs. Per AGENTS.md, comment lines are stripped first: this
 *      route's own prose names `notFound()` and `use client`, and grepping the prose would let a
 *      deleted import keep the gate green.
 *
 * Neither half claims that `/trials/999` 404s. It cannot be known without a chain read, and
 * `src/lib/trial-id.ts` says why. The status codes themselves were confirmed against a real
 * `next start` — see the run notes, not this file.
 */

const read = (rel: string) =>
  readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8").replace(/\r\n/g, "\n");

/** Executable statements only — the file's prose is not the wiring. */
function code(text: string): string {
  return text
    .split("\n")
    .filter((line) => !/^\s*(\/\/|\/\*|\*)/.test(line))
    .join("\n");
}

describe("which segments provably name no trial", () => {
  it("refuses the forms a trial id cannot take", () => {
    // `id = ++trialCount` (CrucibleTrials.sol:405): positive integers, first one is 1.
    for (const segment of ["abc", "0", "-3", "1.5", "007", "1e3", "0x2A", "", " ", "NaN", "Infinity", "+1", "2_0"]) {
      expect(trialIdFromSegment(segment), `segment ${JSON.stringify(segment)} is not a trial id`).toBeNull();
    }
  });

  it("refuses the absent segment and any non-string the caller hands it", () => {
    for (const nothing of [undefined, null, 7, {}]) {
      expect(trialIdFromSegment(nothing as unknown as string | undefined)).toBeNull();
    }
  });

  it("accepts the canonical decimal forms this app actually links to", () => {
    expect(trialIdFromSegment("1")).toBe(1);
    expect(trialIdFromSegment("7")).toBe(7);
    expect(trialIdFromSegment("999")).toBe(999);
    expect(trialIdFromSegment("18446744073709551615")).toBeNull();
    // A segment this long is not a reachable id and is not a resolvable number either; the
    // comment in src/lib/trial-id.ts carries the argument, and the value here is that the
    // behaviour is pinned rather than incidental.
    expect(trialIdFromSegment("9007199254740993")).toBeNull();
  });

  it("does not turn a real id into a different real id", () => {
    // The 404 half is the loud risk, but the silent one is an accepted segment whose digits are
    // not what the page then reads: `Number(" 1 ")` is 1, and a route that quietly rewrites a
    // segment could show trial 1 for a URL that named something else.
    expect(trialIdFromSegment("1 ")).toBeNull();
    expect(trialIdFromSegment("01")).toBeNull();
    expect(trialIdFromSegment("1\u0000")).toBeNull();
  });
});

describe("the route module that decides the status", () => {
  const page = code(read("../src/app/trials/[id]/page.tsx"));

  it("is a server module, because a client component cannot set a status", () => {
    expect(page).not.toMatch(/["']use client["']/);
    expect(page).toMatch(/async function TrialDetailPage/);
    expect(page).toMatch(/await params/);
  });

  it("imports notFound and the predicate, rather than reimplementing either", () => {
    expect(page).toMatch(/import \{ notFound \} from "next\/navigation";/);
    expect(page).toMatch(/import \{ trialIdFromSegment \} from "@\/lib\/trial-id";/);
  });

  it("404s exactly when the predicate says the segment names nothing", () => {
    const gate = page.match(/const trialId = trialIdFromSegment\(id\);[\s\S]{0,120}?if \(trialId === null\) notFound\(\);/);
    expect(gate, "no notFound() call guarded by the predicate — the route is a soft 404 again").toBeTruthy();
    // And the render happens after the guard, so the 404 path cannot also paint the board.
    expect(page.indexOf("<TrialDetail id={trialId} />")).toBeGreaterThan(page.indexOf("notFound();"));
  });

  it("leaves the not-yet-disprovable case a body, in the client module", () => {
    const detail = read("../src/app/trials/[id]/trial-detail.tsx");
    expect(detail).toMatch(/^"use client";/);
    // The "Lost slag." panel is what `/trials/999` still renders; asserting it is here keeps the
    // split honest — the status half moved, the copy half did not.
    expect(detail).toMatch(/Lost slag\./);
    expect(detail).toMatch(/export function TrialDetail\(\{ id \}: \{ id: number \}\)/);
  });
});
