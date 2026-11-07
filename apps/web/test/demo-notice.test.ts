import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { gateMoneyNotice } from "../src/lib/networks";

/**
 * The demo has to say so, out loud, at the button.
 *
 * The audience for this deployment is a judge and a curious visitor, not the person who
 * built it. Both of them can be asked to sign something that moves money, and neither of
 * them should have to hover over a header chip, open a FAQ, or read `HARDENING.md` to
 * learn what the money is where they are standing.
 *
 * The warning is runtime now: the network is chosen by the connected wallet, so the same
 * gate serves a testnet visitor (who must be told the ETH is worthless) and a mainnet
 * visitor (who must be told it is not). The sentences live in `gateMoneyNotice`
 * (`lib/networks.ts`) and are asserted here by *calling* it — a real execution, not a
 * grep of the page source. What remains source-asserted is the rendering side: that the
 * gate actually mounts those sentences as page text, not a tooltip, and carries the
 * custody sentence.
 */

const GATE = readFileSync(
  fileURLToPath(new URL("../src/components/ForgeAuth.tsx", import.meta.url)),
  "utf8",
);

/**
 * The demo notice, from its opening tag to its close.
 *
 * Whitespace is collapsed to single spaces, because that is what JSX renders. Asserting
 * the rendered shape, not the source layout.
 */
function demoNotice(source: string): string {
  const match = /className="forge-auth__demo"[\s\S]*?<\/p>/.exec(source);
  if (!match) throw new Error(
    "the gate no longer renders a demonstration notice (class forge-auth__demo). " +
      "If that is deliberate, delete this test in the same change — a silently absent " +
      "warning is the failure this file exists to catch.",
  );
  return match[0].replace(/\s+/g, " ");
}

describe("the money warning the gate renders", () => {
  it("is rendered page text, not a tooltip", () => {
    const notice = demoNotice(GATE);
    // The whole point of repeating it here: a `title` is not a warning a stranger sees.
    expect(notice).not.toMatch(/title=/);
    expect(GATE).toMatch(/<p className="forge-auth__demo"/);
  });

  it("renders the runtime notice, lead and body, in the page", () => {
    // The sentences are selected by the connected chain at runtime; this is the wiring
    // that puts them on the page. If the <p> stops rendering `money.lead`/`money.body`,
    // every assertion about the sentences below is measuring something nobody sees.
    const notice = demoNotice(GATE);
    expect(notice).toMatch(/<strong>\{money\.lead\}<\/strong>/);
    expect(notice).toMatch(/\{money\.body\}/);
  });

  it("keys the warning to the connected wallet's chain", () => {
    // Wiring check, on the executed statement: the notice must be built from the
    // account's chainId (falling back to the build default only when disconnected),
    // not from a constant that would ignore where the wallet actually is.
    const statements = GATE.split("\n")
      .map((l) => l.replace(/\/\/.*$/, "").trim())
      .filter((l) => l.length > 0 && !l.startsWith("*") && !l.startsWith("/*"))
      .join("\n");
    expect(statements).toMatch(/chainId === undefined \? activeChain\(\) : chainFromId\(chainId\)/);
    expect(statements).toMatch(/gateMoneyNotice\(/);
  });
});

describe("the sentences, per network (gateMoneyNotice, called for real)", () => {
  it("says plainly on testnet that the money has no value", () => {
    for (const chain of ["sepolia", "foundry"] as const) {
      const notice = gateMoneyNotice(chain);
      expect(notice.lead.toLowerCase(), chain).toContain("demonstration");
      expect(notice.body, chain).toMatch(/test ETH/);
      expect(notice.body, chain).toMatch(/worth nothing/);
      expect(notice.body, chain).toMatch(/spend anything real/);
    }
  });

  it("warns differently on mainnet, where the value is real", () => {
    const notice = gateMoneyNotice("mainnet");
    expect(notice.lead).toMatch(/This is the real network\./);
    expect(notice.body).toMatch(/real value/);
    expect(notice.body).toMatch(/cannot get back/);
    expect(notice.body).toMatch(/Think before you sign/);
    // The mainnet arm must not borrow the worthless-ETH sentence: there the value is real.
    expect(notice.body).not.toMatch(/worth nothing/);
  });

  it("warns a wallet on an unknown network instead of guessing its money", () => {
    // A chain this app does not know has money nobody here can vouch for; the honest
    // sentence is "this forge does not run there", not either of the two above.
    const notice = gateMoneyNotice(null);
    expect(notice.lead).toMatch(/different network/);
    expect(notice.body).toMatch(/does not know/);
    expect(notice.body).not.toMatch(/worth nothing/);
    expect(notice.body).not.toMatch(/real value/);
  });

  /**
   * The register the product already writes in: plain words a visitor knows, kept in the
   * forge's own voice. "Anvil", "31337", "testnet" and "Sepolia" are what whoever built
   * this calls it; the sentence has to survive without them.
   */
  it("carries no engineering vocabulary in any arm", () => {
    for (const chain of ["sepolia", "foundry", "mainnet", null] as const) {
      const notice = gateMoneyNotice(chain);
      const text = `${notice.lead} ${notice.body}`;
      for (const jargon of ["Anvil", "31337", "testnet", "Sepolia", "RPC", "chainId", "wei", "bytes32"]) {
        expect(text, `the ${chain ?? "unknown"} arm explains the money using "${jargon}"`).not.toContain(jargon);
      }
    }
  });
});

describe("the custody sentence at the gate", () => {
  it("does not promise custody it does not have", () => {
    // ADR-0006: the API holds no chain key and cannot sign for anyone. The notice says the
    // wallet signs, so a reader cannot conclude a staff key is sitting behind this form.
    const notice = demoNotice(GATE);
    expect(notice).toMatch(/we ask it to sign/);
    expect(notice).toMatch(/never hold a key/);
  });

  it("reaches the notice whatever the mode, because both modes connect a wallet", () => {
    // The gate renders one component for sign-in and sign-up, so the warning cannot be
    // conditional on `fresh` without one of the two pages going dark.
    expect(GATE).toMatch(/forge-auth__demo[\s\S]*$/);
    const conditional = /\{fresh[\s\S]{0,120}forge-auth__demo/.test(GATE);
    expect(conditional, "the demo notice is rendered only in one mode").toBe(false);
  });
});
