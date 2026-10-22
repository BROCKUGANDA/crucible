import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * The demo has to say so, out loud, at the button.
 *
 * The audience for this deployment is a judge and a curious visitor, not the person who
 * built it. Both of them can be asked to sign something that moves money, and neither of
 * them should have to hover over a header chip, open a FAQ, or read `HARDENING.md` to
 * learn that the chain is a local demonstration and the ETH has no value.
 *
 * There is a persistent network badge in the chrome already, and it is honest — but its
 * "the ETH here has no value" sentence lives in a `title` attribute, which is invisible on
 * a phone and to anyone who does not think to hover. So the claim is repeated in rendered
 * text at the gate itself. These tests hold that line, because the easy way for it to
 * disappear is the way it always disappears: someone tidies the markup and the warning
 * becomes a tooltip.
 *
 * Asserted against the source rather than a render, in the style of
 * `no-inline-styles.test.ts`: this repo has no React renderer, and the property under test
 * — "is this sentence in the page, or only in an attribute" — is a property of the markup.
 */

const GATE = readFileSync(
  fileURLToPath(new URL("../src/components/ForgeAuth.tsx", import.meta.url)),
  "utf8",
);

/**
 * The demo notice, from its opening tag to its close.
 *
 * Whitespace is collapsed to single spaces before it is returned, because that is what JSX
 * renders: the sentence is wrapped across source lines for readability, and a test that
 * matched the literal file text would fail on a line break while the page still said the
 * right thing. Asserting the rendered shape, not the source layout.
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

describe("the demonstration notice at the wallet gate", () => {
  it("is rendered text in the page, not a tooltip", () => {
    const notice = demoNotice(GATE);
    // The whole point of repeating it here: a `title` is not a warning a stranger sees.
    expect(notice).not.toMatch(/title=/);
    expect(GATE).toMatch(/<p className="forge-auth__demo"/);
  });

  it("says plainly that the money has no value", () => {
    const notice = demoNotice(GATE);
    expect(notice).toMatch(/test ETH/);
    expect(notice).toMatch(/worth nothing/);
    expect(notice).toMatch(/spend anything real/);
  });

  it("says it is a demonstration in the first words, not the last", () => {
    const notice = demoNotice(GATE);
    const strong = /<strong>([^<]+)<\/strong>/.exec(notice)?.[1] ?? "";
    expect(strong.toLowerCase()).toContain("demonstration");
  });

  /**
   * The register the product already writes in: plain words a visitor knows, kept in the
   * forge's own voice. "Anvil", "31337", "testnet" and "local chain node" are what whoever
   * built this calls it; the sentence has to survive without them.
   */
  it("carries no engineering vocabulary", () => {
    const notice = demoNotice(GATE);
    for (const jargon of ["Anvil", "31337", "testnet", "Sepolia", "RPC", "chainId", "wei", "bytes32"]) {
      expect(notice, `the gate explains the demo using "${jargon}"`).not.toContain(jargon);
    }
  });

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
