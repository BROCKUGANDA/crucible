import { SEED_PHRASE_GUARANTEE } from "@/lib/safety";

/**
 * The sentence, always on screen.
 *
 * A warning that only appears after something has gone wrong is a warning a visitor reads after
 * the fact. This one is a standing line in the chrome and at the wallet gate, because the
 * question it answers — "is this page about to ask me for the twelve words?" — is asked before
 * anyone types anything, and by the person least able to check whether the answer is true.
 *
 * It is also the only honest form of the claim: nothing here asks for a seed, the API holds no
 * chain key (ADR-0006), and the wallet signs in the visitor's own browser. Saying it permanently
 * is cheaper than proving it once, and it is the sentence the paste guard points at when it
 * refuses.
 *
 * Rendered as a `client`-free component on purpose: it reads no wallet, no storage and no
 * stream, so it stays legal above the provider boundary — the root `loading.tsx` and
 * `global-error.tsx` must import nothing that touches the wallet, and a constant cannot.
 */
export function SeedPhrasePromise() {
  return (
    <p className="hint hint--block" data-seed-promise="true">
      {SEED_PHRASE_GUARANTEE}
    </p>
  );
}
