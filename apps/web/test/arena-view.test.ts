import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { arenaView } from "@/lib/arena-view";

/**
 * The Arena page is the surface ADR-0019 requires, and its whole job is to keep three
 * empty-looking states apart. The API already distinguishes them — `projected: false` is a fact
 * about this host, `projected: true` with no trials is a fact about the arena — and a page that
 * collapsed them would rebuild the exact ambiguity the fee argument kept losing itself in.
 */

const READ = (p: string) => readFileSync(fileURLToPath(new URL(p, import.meta.url)), "utf8");

describe("arenaView", () => {
  it("reports unread when nothing came back, and never as zero", () => {
    expect(arenaView(null)).toMatchObject({ kind: "unread" });
    expect(JSON.stringify(arenaView(undefined))).not.toContain("0 trials");
  });

  it("says the host has no arena, quoting the API's own reason", () => {
    const v = arenaView({ data: { trials: [] }, meta: { projected: false, reason: "no arena address on this host" } });
    expect(v).toEqual({ kind: "not-projected", reason: "no arena address on this host" });
  });

  it("distinguishes an arena that was read and is empty", () => {
    const v = arenaView({ data: { trials: [] }, meta: { projected: true, count: 0 } });
    expect(v.kind).toBe("empty");
  });

  it("prints only fields that arrived, with an em dash for the rest", () => {
    const v = arenaView({ data: { trials: [{ id: 3, state: "Open" }, { id: 4 }] }, meta: { projected: true } });
    expect(v).toMatchObject({ kind: "list", count: 2 });
    if (v.kind !== "list") throw new Error("unreachable");
    expect(v.rows[0]).toEqual({ id: "3", state: "Open", reward: "—" });
    expect(v.rows[1]).toEqual({ id: "4", state: "—", reward: "—" });
  });

  it("does not invent a list from a payload with no trials array", () => {
    expect(arenaView({ data: {}, meta: { projected: true } }).kind).toBe("empty");
  });
});

describe("the page and its door", () => {
  const PAGE = READ("../src/app/arena/page.tsx");
  const CHROME = READ("../src/components/Chrome.tsx");

  it("is in the primary navigation", () => {
    expect(CHROME).toMatch(/href: "\/arena"/);
  });

  it("renders every state it can be in", () => {
    for (const state of ['kind === "unread"', 'kind === "not-projected"', 'kind === "empty"', 'kind === "list"']) {
      expect(PAGE, `arena page does not render ${state}`).toContain(state);
    }
  });

  it("says the fee is charged to the sponsor and refunded, in plain words", () => {
    expect(PAGE).toMatch(/charged to\s+the sponsor/);
    expect(PAGE).toMatch(/returned with the reward/);
  });
});
