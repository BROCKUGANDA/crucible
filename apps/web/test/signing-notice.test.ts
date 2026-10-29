import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * The warning has to be at the signature, not at the login.
 *
 * `demo-notice.test.ts` holds the sentence at the wallet gate, and the gate held. What nobody
 * noticed is where the signatures actually happen: `/trials/new` escrows a reward and `/forge`
 * stakes a bond, and both screens carried no demonstration notice and no mention of what sending
 * a transaction costs. A visitor who never went near `/sign-in` could post real money-looking
 * values with neither sentence in front of them.
 *
 * So this file holds three things: the notice is rendered on both signing surfaces, it is rendered
 * text rather than an attribute, and the gas sentence says plainly that the number is not measured
 * here — because an estimate printed where no estimate was taken is the same fabrication this
 * project was hunted for everywhere else.
 */

const READ = (relative: string): string =>
  readFileSync(fileURLToPath(new URL(relative, import.meta.url)), "utf8");

const NOTICE = READ("../src/components/SigningNotice.tsx");
const SPONSOR = READ("../src/app/trials/new/page.tsx");
const OPERATOR = READ("../src/app/forge/page.tsx");

/** The two paragraphs of the notice, collapsed to what JSX actually renders. */
function rendered(source: string): string {
  const body = /export function SigningNotice\(\)[\s\S]*?\n\}/.exec(source);
  if (!body) throw new Error(
    "SigningNotice no longer exports a function named SigningNotice. If the warning moved, " +
      "update this file in the same change — do not let it stop being asserted.",
  );
  return body[0].replace(/\s+/g, " ");
}

const TEXT = rendered(NOTICE);

describe("the signing surfaces carry the warning", () => {
  it.each([
    ["the sponsor wizard", SPONSOR],
    ["the operator console", OPERATOR],
  ])("renders the notice on %s", (_name, page) => {
    expect(page).toContain("<SigningNotice />");
    expect(page).toMatch(/import \{ SigningNotice \} from "@\/components\/SigningNotice"/);
  });

  it.each([
    ["the sponsor wizard", SPONSOR],
    ["the operator console", OPERATOR],
  ])("keeps the wrong-network guard beside it on %s", (_name, page) => {
    // The notice is not a substitute for the chain check: a signature on the wrong chain is the
    // other way this page can cost someone real money.
    expect(page).toContain("WrongNetworkNotice");
  });

  it("is rendered text, not a tooltip", () => {
    expect(TEXT).not.toMatch(/title=/);
  });
});

describe("what the notice says", () => {
  it("says plainly that the money has no value", () => {
    expect(TEXT).toMatch(/test ETH/);
    expect(TEXT).toMatch(/worth nothing/);
    expect(TEXT).toMatch(/<strong>This is a demonstration\.<\/strong>/);
  });

  it("says the loss is still real", () => {
    // Worthless metal, consequential actions: a bond staked is locked until the work settles.
    expect(TEXT).toMatch(/at risk/);
  });

  it("names gas, and names that this page did not measure it", () => {
    expect(TEXT).toMatch(/gas/);
    expect(TEXT).toMatch(/does not measure/);
    expect(TEXT).toMatch(/prints no number/);
  });

  it("points at the wallet's own figure as the one to read", () => {
    expect(TEXT).toMatch(/before you sign/);
    expect(TEXT).toMatch(/<em>that<\/em> figure/);
  });

  it("carries no engineering vocabulary", () => {
    for (const jargon of ["Anvil", "31337", "testnet", "Sepolia", "RPC", "chainId", "wei", "bytes32"]) {
      expect(TEXT, `the signing notice explains itself using "${jargon}"`).not.toContain(jargon);
    }
  });

  it("asks for no secret", () => {
    // A warning that turns into a form is how a product starts collecting keys.
    expect(NOTICE).not.toMatch(/<input\b/);
    expect(NOTICE).not.toMatch(/<textarea\b/);
    expect(NOTICE).not.toMatch(/seed phrase\s*<\/label>/);
  });
});
