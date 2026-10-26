import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { VERTICALS } from "../src/lib/verticals.js";

const page = readFileSync(new URL("../src/app/verticals/page.tsx", import.meta.url), "utf8");

describe("verticals page", () => {
  it("names the two graded suites and their artifact counts", () => {
    expect(VERTICALS.map((v) => v.id)).toEqual(["rwa-nav", "payfi-recon"]);
    expect(VERTICALS.map((v) => v.title)).toEqual([
      "RWA NAV reconciliation",
      "PayFi settlement reconciliation",
    ]);
    expect(VERTICALS.every((v) => v.artifacts === 24)).toBe(true);
  });

  it("states the settlement boundary and the on-ramp custody rule", () => {
    expect(page).toContain("native ETH");
    expect(page).toContain("5%");
    expect(page).toContain("no custody");
    expect(page).toContain("onrampUrl");
    expect(page).toContain("CRUCIBLE never holds it");
  });

  it("links the MCP surface without claiming a key", () => {
    expect(page).toContain("/mcp");
    expect(page).toContain("No tool holds a key");
  });
});
