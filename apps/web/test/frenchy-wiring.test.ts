import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * The wiring, checked against the code that runs.
 *
 * `provider.tsx` was committed as 379 lines that nothing imported: no mount, no consumer, no
 * test. A module can be perfect and still be a fixture, and the standing gate on the Argus side
 * (`packages/argus/test/no-orphan.test.ts`) already says so. React cannot be rendered in this
 * suite, so a source-level check is the only instrument available for "is this mounted" — and a
 * source-level check is worth exactly nothing unless it reads statements.
 *
 * So every file below is run through `code()` first, which removes block and line comments. That
 * is not decoration: the provider's own prose contains the string `abort()`, and a test written
 * against the raw text would stay green after someone deleted the call — the precise failure
 * `AGENTS.md` records against a wiring assertion that matched a script's comments. The first test
 * in this file proves the filter is doing that work.
 */

function source(path: string): string {
  return readFileSync(fileURLToPath(new URL(path, import.meta.url)), "utf8");
}

/** Comments removed, so an assertion can only be satisfied by an executed statement. */
function code(path: string): string {
  return source(path)
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .split(/\r?\n/)
    .filter((line) => !line.trim().startsWith("//"))
    .join("\n");
}

const PROVIDER = "../src/lib/frenchy/provider.tsx";
const PROVIDERS = "../src/components/Providers.tsx";
const CONTROL = "../src/components/FrenchyAsk.tsx";
const CHROME = "../src/components/Chrome.tsx";
const GATE = "../src/components/ForgeAuth.tsx";
const FORGE = "../src/app/forge/page.tsx";
const BREAK = "../src/components/BreakPanel.tsx";
const STATUS = "../src/lib/frenchy/status.ts";
const SAFETY = "../src/lib/safety.ts";

describe("the instrument itself", () => {
  /**
   * Proves the filter strips prose, on a sentence this file genuinely depends on.
   *
   * The provider explains the abort in its own header comment, using the word `abort()`. If
   * `code()` did not remove it, every abort assertion below would be satisfied by the comment
   * and the mutation that deletes the call would pass.
   */
  it("removes comments, including one that names the thing being asserted", () => {
    expect(source(PROVIDER)).toContain("without `abort()` is plumbing");
    expect(code(PROVIDER)).not.toContain("plumbing");
    expect(code(PROVIDER)).toContain("abortControllerRef.current?.abort()");
  });
});

describe("the provider is mounted, not merely present", () => {
  it("is imported and rendered by the file that composes the providers", () => {
    const providers = code(PROVIDERS);
    expect(providers).toContain('from "@/lib/frenchy/provider"');
    expect(providers).toContain("<FrenchyProvider>");
  });

  /**
   * Inside `WagmiProvider`, because the provider reads the account.
   *
   * Ordering is the whole risk here: `useAccount` above its provider throws during prerender,
   * and the build is the only thing that will say so — which is the failure this repo already
   * had with `useConfig must be used within WagmiProvider`. Asserted on index positions rather
   * than a regex over the JSX, because the nesting is what matters, not the formatting.
   */
  it("sits under WagmiProvider and above the pages", () => {
    const providers = code(PROVIDERS);
    expect(providers.indexOf("<WagmiProvider")).toBeGreaterThanOrEqual(0);
    expect(providers.indexOf("<FrenchyProvider>")).toBeGreaterThan(providers.indexOf("<WagmiProvider"));
  });

  it("is consumed by a control that Chrome renders", () => {
    expect(code(CONTROL)).toContain("useFrenchy()");
    expect(code(CHROME)).toContain("<FrenchyAsk />");
  });
});

describe("cancellation is wired, not plumbed", () => {
  it("fires the controller instead of only passing a signal", () => {
    const provider = code(PROVIDER);
    expect(provider).toContain("abortControllerRef.current?.abort()");
    expect(provider.match(/signal: controller\.signal/g)?.length).toBe(2);
  });

  /**
   * The brain's answer and the clip share one controller.
   *
   * A signal on the chat request but not on `frenchy/voice` would leave a playing clip behind a
   * muted host, because the clip is the part a visitor actually hears.
   */
  it("puts the voice fetch under the same cancellation", () => {
    const provider = code(PROVIDER);
    expect(provider).toContain("FRENCHY_VOICE_API");
    expect(provider).toMatch(/body: JSON\.stringify\(\{ text \}\),\s*signal: controller\.signal/);
  });

  it("routes both through the API origin, never a same-origin /api path", () => {
    const provider = code(PROVIDER);
    expect(provider).toContain("const FRENCHY_API = `${API_BASE}/frenchy`;");
    expect(provider).toContain("const FRENCHY_VOICE_API = `${API_BASE}/frenchy/voice`;");
    expect(provider).not.toContain('"/api/frenchy"');
    expect(code(STATUS)).toContain("`${API_BASE}/frenchy`");
  });

  it("runs one teardown on unmount and no second stop that could race it", () => {
    const provider = code(PROVIDER);
    expect(provider).toContain("teardownFrenchy({");
    expect(provider).toContain("cancelUtterance({");
    // The recognizer used to be stopped by its own effect cleanup; the teardown owns it now.
    expect(provider).not.toMatch(/recognition\.stop\(\)/);
  });

  it("keeps the snapshot stream out of the provider", () => {
    // Nothing in this file read the snapshot, and mounting it app-wide would add a second live
    // stream to every page for data the server injects itself.
    expect(code(PROVIDER)).not.toContain("useSnapshot(");
  });

  /**
   * The wallet is real.
   *
   * A `useWallet()` that returned `null` under a comment promising a wagmi version is the shape
   * of fake this repo bans on a runtime path: the brain would be told "not connected" while the
   * header showed an address, and every answer about the visitor's own money would be wrong.
   */
  it("reads the account rather than a stub", () => {
    const provider = code(PROVIDER);
    expect(provider).not.toMatch(/function useWallet/);
    expect(provider).toContain("useAccount()");
    expect(provider).toContain("wallet: walletRef.current");
  });

  /**
   * The stale-closure mirrors.
   *
   * The recognizer's handlers are installed once, so the state and history they read have to
   * come from refs; without these three writes the host sat on "listening" forever and the brain
   * never saw a second sentence.
   */
  it("mirrors every value a once-installed handler reads", () => {
    const provider = code(PROVIDER);
    expect(provider).toContain("stateRef.current = state;");
    expect(provider).toContain("messagesRef.current = messages;");
    expect(provider).toContain("mutedRef.current = isMuted;");
    // The handler itself, not merely the existence of a mirror somewhere in the file.
    expect(provider).toContain("const current = stateRef.current;");
    expect(provider).toMatch(/const history = messagesRef\s*\.current\s*\.slice\(-12\)/);
  });
});

describe("the control degrades to absent", () => {
  /**
   * The same shape `VoiceControl` uses, for the same reason.
   *
   * A microphone button on a host with no brain is a button that always fails, and the visitor
   * cannot tell a misconfigured page from a broken one.
   */
  it("renders nothing until the probe says there is a brain", () => {
    const control = code(CONTROL);
    expect(control).toContain("fetchFrenchyBrainStatus()");
    expect(control).toMatch(/if \(!ready \|\| !configured\) return null;/);
  });

  it("guards the free-text field on paste and on send", () => {
    const control = code(CONTROL);
    expect(control).toContain("guardPastedText(");
    expect(control).toContain("detectMnemonic(");
    expect(control).toContain("onPaste={onPaste}");
    expect(control).toContain("event.preventDefault()");
    expect(control).toContain("{SEED_PHRASE_GUARANTEE}");
  });
});

describe("the seed promise is on screen, not in a tooltip", () => {
  /**
   * "Permanent and visible" means the chrome and the gate, both.
   *
   * The auth gate hides the chrome deliberately (`console.css` turns `.forge-auth .chrome` off),
   * so a footer line alone would drop the sentence from the one screen that asks a stranger to
   * connect a wallet. Both are asserted because both were the places it could silently vanish.
   */
  it("is rendered by the chrome footer and by the wallet gate", () => {
    expect(code(CHROME)).toContain("<SeedPhrasePromise />");
    expect(code(GATE)).toContain("<SeedPhrasePromise />");
    expect(code("../src/components/SeedPhrasePromise.tsx")).toContain("{SEED_PHRASE_GUARANTEE}");
  });

  it("is a text node, not a title attribute", () => {
    const promise = code("../src/components/SeedPhrasePromise.tsx");
    expect(promise).toMatch(/<p className="hint hint--block"[^>]*>\s*\{SEED_PHRASE_GUARANTEE\}\s*<\/p>/);
    expect(promise).not.toMatch(/title=/);
  });
});

describe("the validator is called before the wallet is asked to sign", () => {
  /**
   * The forge form is the one place in the app that turns a typed address into a signature.
   *
   * It used to check the shape and nothing else, which is how a runner key pasted from another
   * chain passed, opened the confirm dialog, and asked the wallet to sign for a contract that is
   * not deployed there. The assertion is on the derivation of `runnerValid` — if the button's
   * predicate were reintroduced without the network check, this fails.
   */
  it("drives the register button off the shared check", () => {
    const forge = code(FORGE);
    expect(forge).toContain("checkAddressTarget({");
    expect(forge).toContain("connectedChainId: accountChainId");
    expect(forge).toContain("expectedChainId: dep.chainId");
    expect(forge).toContain("const runnerValid = runnerCheck.ok;");
    expect(forge).toContain('from "@/lib/safety"');
  });

  it("guards every free-text field that money is asked about", () => {
    const forge = code(FORGE);
    expect(forge.match(/onPaste=\{refuseSeedPaste\}/g)?.length).toBe(2);
    expect(forge).toContain("guardPastedText(");

    const breakPanel = code(BREAK);
    expect(breakPanel).toContain("guardPastedText(");
    expect(breakPanel).toContain("onPaste={refuseSeedPaste}");
  });

  /**
   * The guarantee has one definition.
   *
   * Named here rather than trusted: `SEED_PHRASE_GUARANTEE` is exported from `lib/safety.ts`, and
   * a second copy of the sentence pasted into a component would be a second promise.
   */
  it("comes from the shared module, and nowhere else defines it", () => {
    expect(code(SAFETY)).toContain('export const SEED_PHRASE_GUARANTEE = "CRUCIBLE will never ask for your seed phrase.";');
    for (const file of [CONTROL, CHROME, GATE, FORGE, BREAK]) {
      expect(code(file), file).not.toContain("SEED_PHRASE_GUARANTEE =");
    }
  });
});
