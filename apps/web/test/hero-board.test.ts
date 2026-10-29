import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { ApiSnapshot, ApiTrial, TrialStatus } from "@crucible/indexer";
import { heroBoardFrom, heroBondLine } from "@/lib/hero-board";

/**
 * The hero card reads the board or it says it cannot.
 *
 * Until 2026-10-29 the card on `https://crucible.svalley.tech/` said `#42 · Summarise a receipt ·
 * 0.5 ETH · open · bond 0.05 ETH to play` under the heading "Live on the board". `/api/snapshot`
 * was returning ids 1-8, all at 1 ETH; no trial has ever had a title, because the chain stores a
 * spec digest; and the bond was a rounded guess. It was server-rendered, so the invented figures
 * were the first money on the page and the only ones nobody had measured. That is the exact
 * failure the display rule exists to stop, and it survived every other gate this repo has.
 *
 * Two kinds of test are here because the failure had two halves. The pure mapping is asserted in
 * pairs — an em dash for what was not read, a digit for what was — the way `ops.test.ts` does it.
 * The markup is asserted against source, the way `demo-notice.test.ts` does it, because a
 * hardcoded prop is a property of the file and there is no React renderer here to catch it.
 */

function trial(over: Partial<ApiTrial>): ApiTrial {
  return {
    id: 1,
    status: "open",
    rewardEth: "1",
    bondEth: "0.2",
    specCID: "bafybeigdyrte5av7gjbmeqobrav22fahi5o7ybsowxnykqkmn33x6m4lzy",
    testsCID: "bafybeihdwdcefgh4dqkjv67uzcmw7ojh4txq3l4b3qk2n3q6y7rz5m4lzy",
    ...over,
  } as ApiTrial;
}

function snapshot(trials: ApiTrial[]): ApiSnapshot {
  return { now: 1_800_000_000_000, trials } as unknown as ApiSnapshot;
}

describe("heroBoardFrom — which trial the card is allowed to name", () => {
  it("names the newest open trial, not whichever order the index returned", () => {
    const board = heroBoardFrom(snapshot([trial({ id: 3 }), trial({ id: 7 })]));
    expect(board).toMatchObject({ kind: "trial", id: 7 });
  });

  it("will not present a claimed trial as open to claim", () => {
    const board = heroBoardFrom(
      snapshot([trial({ id: 9, status: "assigned" }), trial({ id: 4, status: "open" })]),
    );
    expect(board).toMatchObject({ kind: "trial", id: 4 });
  });

  it.each<TrialStatus>(["assigned", "judging", "challenged", "settled"])("skips a %s trial", (status) => {
    expect(heroBoardFrom(snapshot([trial({ id: 5, status })]))).toEqual({ kind: "empty" });
  });

  it("says nothing is claimable when the board answered with an empty list", () => {
    // A read that came back empty is a measurement, and it is not the same sentence as a read
    // that failed. The card must not invent a trial to fill the gap.
    expect(heroBoardFrom(snapshot([]))).toEqual({ kind: "empty" });
  });

  it.each([null, undefined])("reports unread for a %s payload", (payload) => {
    expect(heroBoardFrom(payload)).toEqual({ kind: "unread" });
  });

  it("reports unread when the payload has no trials array at all", () => {
    expect(heroBoardFrom({ now: 1 } as unknown as ApiSnapshot)).toEqual({ kind: "unread" });
  });
});

describe("heroBoardFrom — what the card prints", () => {
  const board = heroBoardFrom(snapshot([trial({ id: 7, rewardEth: "1", bondEth: "0.2" })]));

  it("carries the reward and the bond the chain published, unit included", () => {
    // `formatEth` prints the unit, so the card must not print a second one.
    expect(board).toMatchObject({ kind: "trial", reward: "1 ETH", bond: "0.2 ETH" });
  });

  it("links to the trial it named rather than to the board in general", () => {
    expect(board).toMatchObject({ href: "/trials/7" });
  });

  it("says the spec is undisclosed instead of printing a digest that was never published", () => {
    const hidden = heroBoardFrom(snapshot([trial({ id: 8, specCID: null })]));
    expect(hidden).toMatchObject({ spec: "spec not disclosed yet" });
  });

  it("shows an unknown bond as an unknown, never as a number", () => {
    expect(heroBondLine("—")).toBe("bond —");
    expect(heroBondLine("0.2")).toBe("bond 0.2 to claim");
  });
});

const PAGE = readFileSync(fileURLToPath(new URL("../src/app/page.tsx", import.meta.url)), "utf8");
const HERO = readFileSync(
  fileURLToPath(new URL("../src/components/LiveFeed.tsx", import.meta.url)),
  "utf8",
);

/** The preview card region of the landing page, from its opening tag to the scroll cue. */
function previewRegion(source: string): string {
  const match = /<div className="arena__preview"[\s\S]*?<\/div>/.exec(source);
  if (!match) throw new Error(
    "the landing page no longer renders a preview card (class arena__preview). If that is " +
      "deliberate, delete this test in the same change — the fabrication this file exists to " +
      "catch was a card someone removed the numbers from and left the prose standing.",
  );
  return match[0];
}

describe("the landing page must not carry a prop-shaped board", () => {
  it("delegates the card to the component that reads the board", () => {
    expect(previewRegion(PAGE)).toContain("<HeroBoardPreview />");
  });

  it("holds no trial id of its own", () => {
    // The bug was `arena__preview__id">#42`. Any literal digits after a `#` inside the landing
    // page's own markup are a measurement nobody read.
    const heroMarkup = PAGE.replace(/^\s*\/\/.*$/gm, "");
    expect(heroMarkup).not.toMatch(/arena__preview__id">#\d+/);
  });

  it("holds no ETH amount of its own in the card", () => {
    expect(previewRegion(PAGE)).not.toMatch(/\d+(\.\d+)?\s*ETH/);
  });

  it("holds no invented trial title anywhere in the app", () => {
    // A title is not a field the chain has; the sentence existed only to look like one.
    expect(PAGE).not.toContain("Summarise a receipt");
    expect(HERO).not.toContain("Summarise a receipt");
  });

  it("renders the card through a read, not through useSnapshot's stream", () => {
    // Two EventSources per landing view would double the long-lived connections on the busiest
    // page of a single-host deployment. The ticker below keeps the stream; the card does not.
    const heroComponent = /export function HeroBoardPreview\(\)[\s\S]*?\n\}/.exec(HERO)?.[0] ?? "";
    expect(heroComponent).toContain("fetch(");
    expect(heroComponent).not.toContain("useSnapshot(");
    expect(heroComponent, "the card must be able to say it read nothing").toContain("unread");
  });
});
