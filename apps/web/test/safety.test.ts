import { describe, expect, it } from "vitest";
import {
  checkAddressTarget,
  detectMnemonic,
  guardPastedText,
  SEED_PHRASE_GUARANTEE,
} from "../src/lib/safety.js";

/**
 * The guards, tested as pure logic.
 *
 * No renderer exists in this suite (see `demo-notice.test.ts`), and the two decisions below are
 * decisions rather than pixels: *is this string an address this wallet can be asked to act on*
 * and *does this paste read like a wallet backup*. Both are answerable without a DOM, and the
 * warning copy that hangs off them is asserted at the call sites in `frenchy-wiring.test.ts`.
 *
 * The seed vector is the all-zero-entropy BIP-39 phrase — twelve real words from the English
 * list, which is what the detector is meant to recognise. The prose vectors are what it is
 * meant to leave alone: an IPFS manifest link, a proof written in ordinary sentences.
 */

const TWELVE = "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";
const TWELVE_DISTINCT =
  "abandon ability able about above absent absorb abstract absurd abuse access accident";
const TWENTY_FOUR = `abandon ability able about above absent absorb abstract absurd abuse access accident
achieve acid acoustic acquire across act action actor actress actual adapt add`.replace(/\n/g, " ");

/** The 12-word phrase with a human sentence in front of it, as people actually paste it. */
const LABELLED = `my seed is: ${TWELVE_DISTINCT}`;

const PROOF_PROSE =
  "The agent claimed the trial and submitted a run that failed the pinned suite, because suite exited nonzero.";
/**
 * Twelve consecutive words of ordinary English, every one of them three to eight letters — the
 * only shape a run-based detector cannot tell apart from a key by length alone.
 *
 * This is the vector the marker veto exists for: what separates the sentence from a seed phrase
 * is that a seed contains no "the", no "and", no "because". Long words ("submitted") and short
 * ones ("a") break a run by themselves, so this one is written without either.
 */
const TWELVE_WORD_SENTENCE = "the agent claimed the trial and filed the run because suite exited";
const MANIFEST_URI = "ipfs://bafybeigdyrzt5sfp7udm7hu76uh7y26nf3dfuylqabf3oclgtqy55fbzri";
const GOOD_ADDRESS = "0x1234567890123456789012345678901234567890";
const ZERO_ADDRESS = `0x${"0".repeat(40)}`;

describe("address check", () => {
  it("passes a plain address and hands the trimmed value back", () => {
    const check = checkAddressTarget({ value: `  ${GOOD_ADDRESS}  ` });
    expect(check.ok).toBe(true);
    expect(check.problems).toEqual([]);
    expect(check.address).toBe(GOOD_ADDRESS);
  });

  /**
   * Format first, and *only* format.
   *
   * The two checks are different questions, and answering the second one about a string that is
   * not an address would tell the reader to switch networks when the field is what is broken.
   */
  it("stops at the format when the string is not an address at all", () => {
    for (const value of ["0x123", "1234567890123456789012345678901234567890", GOOD_ADDRESS.slice(0, -1) + "g", ""]) {
      const check = checkAddressTarget({ value, connectedChainId: 1, expectedChainId: 31337 });
      expect(check.ok, value).toBe(false);
      expect(check.address, value).toBeNull();
      expect(check.problems.map((p) => p.check), value).toEqual(["format"]);
    }
  });

  it("treats the all-zeros address as an error unless the form means it", () => {
    expect(checkAddressTarget({ value: ZERO_ADDRESS }).ok).toBe(false);
    expect(checkAddressTarget({ value: ZERO_ADDRESS }).problems[0]?.check).toBe("zero");
    expect(checkAddressTarget({ value: ZERO_ADDRESS, allowZeroAddress: true }).ok).toBe(true);
  });

  /**
   * The mismatch is a warning, and a warning is not a pass.
   *
   * `ok` goes false on it because the alternative is what the repo already did: the field turned
   * green, the confirm dialog opened, and the wallet was asked to sign on a chain where the
   * address means nothing. The kind is still `warning` so the copy can say "switch networks"
   * rather than "that is not an address".
   */
  it("refuses to proceed quietly when the wallet is on another network", () => {
    const check = checkAddressTarget({ value: GOOD_ADDRESS, connectedChainId: 1, expectedChainId: 31337 });
    expect(check.ok).toBe(false);
    expect(check.problems).toHaveLength(1);
    expect(check.problems[0]?.kind).toBe("warning");
    expect(check.problems[0]?.message).toMatch(/different network/);
  });

  it("says nothing about the network when the chains agree or nobody is connected", () => {
    expect(
      checkAddressTarget({ value: GOOD_ADDRESS, connectedChainId: 31337, expectedChainId: 31337 }).problems,
    ).toEqual([]);
    expect(
      checkAddressTarget({ value: GOOD_ADDRESS, connectedChainId: null, expectedChainId: 31337 }).problems,
    ).toEqual([]);
    expect(checkAddressTarget({ value: GOOD_ADDRESS, connectedChainId: 31337 }).problems).toEqual([]);
  });
});

describe("seed-phrase detector", () => {
  it("recognises every BIP-39 word count", () => {
    expect(detectMnemonic(TWELVE)?.wordCount).toBe(12);
    expect(detectMnemonic(TWELVE_DISTINCT)?.wordCount).toBe(12);
    for (const words of [15, 18, 21]) {
      expect(detectMnemonic("abandon ".repeat(words).trim())?.wordCount).toBe(words);
    }
    expect(detectMnemonic(TWENTY_FOUR)?.wordCount).toBe(24);
  });

  /**
   * The phrase behind a label is still the phrase.
   *
   * "my seed is: …" is how a person pastes it. The run rule is what catches it: the one- and
   * two-letter words around the phrase are not word-shaped, so they end the run instead of
   * joining it, and what is left is exactly twelve.
   */
  it("catches a phrase pasted after a sentence", () => {
    expect(detectMnemonic(LABELLED)?.wordCount).toBe(12);
  });

  it("counts the words back so the warning can say them", () => {
    expect(detectMnemonic(TWELVE)?.words).toHaveLength(12);
  });

  /**
   * The other half of the gate, and the one that decides the shape of the rule.
   *
   * A detector that flags ordinary English would refuse a skeptic their proof, which is a worse
   * outcome than missing an unusual key. These are the strings that have to pass through: a
   * manifest link, a paragraph of prose, a short answer, a hex address, and a sentence of twelve
   * words that contains function words.
   */
  it("leaves ordinary text alone", () => {
    for (const text of [
      PROOF_PROSE,
      TWELVE_WORD_SENTENCE,
      MANIFEST_URI,
      "which trials are still open?",
      GOOD_ADDRESS,
      "the forge is running but the agent did not submit anything at all today",
      "suite exited with code 1 on the pinned test",
      "12",
      "",
    ]) {
      expect(detectMnemonic(text), text).toBeNull();
    }
  });

  it("does not fire on a run of the wrong length", () => {
    expect(detectMnemonic("abandon ".repeat(13).trim())).toBeNull();
    expect(detectMnemonic("abandon ".repeat(11).trim())).toBeNull();
  });
});

describe("the paste guard's decision", () => {
  it("refuses a phrase and names the guarantee in the warning", () => {
    const decision = guardPastedText(LABELLED);
    expect(decision.refuse).toBe(true);
    if (!decision.refuse) throw new Error("unreachable: the branch above is the assertion");
    expect(decision.warning).toMatch(/12-word/);
    expect(decision.warning).toContain(SEED_PHRASE_GUARANTEE);
  });

  it("lets a manifest through untouched", () => {
    expect(guardPastedText(MANIFEST_URI)).toEqual({ refuse: false });
  });
});

/**
 * The sentence is a constant rather than a string typed at three call sites, because a promise
 * that reads "Crucible will never ask for your seed phrase" in one place and "please never share
 * your seed phrase" in another is two promises, and neither is this one.
 */
describe("the standing promise", () => {
  it("is exactly the sentence the product makes", () => {
    expect(SEED_PHRASE_GUARANTEE).toBe("CRUCIBLE will never ask for your seed phrase.");
  });
});
