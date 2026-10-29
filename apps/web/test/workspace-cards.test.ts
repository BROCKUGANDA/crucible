import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { agentCard } from "@/lib/workspace-cards";

/**
 * The card a visitor checks to answer "am I in?".
 *
 * The live audit found the workspace asserting an agent tier while the wallet row beside it said
 * "disconnected". Whether that exact combination was a stale wagmi address or something else, the
 * defect is structural: the card asked a question about a wallet it had not read and printed an
 * answer anyway. These cases hold the three states apart.
 */

describe("agentCard", () => {
  it("claims nothing about an agent when no wallet was read", () => {
    expect(agentCard({ walletRead: false, tier: null, hasAgent: false })).toEqual({
      value: "—",
      hint: "no wallet connected",
      tone: "pending",
    });
  });

  it("does not report a stale address as a read wallet", () => {
    // `walletRead` is isConnected && address. An address left in wagmi's storage while the
    // connection is gone arrives here as false, and gets the honest answer.
    expect(agentCard({ walletRead: false, tier: 1, hasAgent: true }).hint).toBe("no wallet connected");
  });

  it("says the wallet has no agent, which is a different sentence", () => {
    expect(agentCard({ walletRead: true, tier: null, hasAgent: false })).toEqual({
      value: "—",
      hint: "this wallet has no agent yet",
      tone: "pending",
    });
  });

  it("prints the tier only when it arrived", () => {
    expect(agentCard({ walletRead: true, tier: 1, hasAgent: true })).toEqual({
      value: "Tier 1",
      hint: "registered",
      tone: "success",
    });
  });

  it("prints an agent with an unread tier as an unknown, never as tier zero", () => {
    const card = agentCard({ walletRead: true, tier: undefined, hasAgent: true });
    expect(card.value).toBe("Tier —");
    expect(card.value).not.toMatch(/Tier 0/);
  });
});

describe("the page uses the decision, not a ternary", () => {
  const PAGE = readFileSync(fileURLToPath(new URL("../src/app/home/page.tsx", import.meta.url)), "utf8");

  it("derives the card from agentCard()", () => {
    expect(PAGE).toContain("agentCard(");
  });

  it("requires both isConnected and an address before calling the wallet read", () => {
    expect(PAGE).toMatch(/walletRead:\s*isConnected\s*&&\s*Boolean\(address\)/);
  });
});
