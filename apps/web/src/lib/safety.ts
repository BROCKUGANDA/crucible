/**
 * The two guards every input that touches money should have.
 *
 * Both exist because the failure they prevent is not a crash, it is a person losing
 * something and blaming the page:
 *
 *   1. **An address that is not this forge's.** A typo in a runner key is a bond pointed at
 *      a stranger; a wallet on the wrong network is a transaction that cannot land. The
 *      format check already lived in `eth.ts` and the network check already lived in
 *      `Wallet.tsx`'s `WrongNetworkNotice`, each consulted separately, so a form could
 *      validate one and silently skip the other. This composes both into the single answer
 *      a call site has to act on, and it never proceeds quietly past a mismatch.
 *   2. **A seed phrase pasted into a text box.** Nothing in this product has a use for one:
 *      the wallet signs, the API holds no chain key (ADR-0006), and the only credential the
 *      forge ever asks for is a connector approval. A box that accepts one is a box a
 *      phishing page can imitate, so the box refuses it out loud and the page says, all the
 *      time, that the question will never be asked.
 *
 * Detection here is deliberately shape-based rather than wordlist-based: the BIP-39 English
 * wordlist is 2048 entries, and shipping it into the browser bundle to guard a paste is a
 * dependency decision, not an input check. What a false negative costs is a paste that
 * behaves like any other paste; what a false positive costs is a proof text the filer cannot
 * file. The rules below are tuned toward the second error — see `englishProseIsNotFlagged`
 * in the test, which is the case that decides the shape.
 */

/** Said in the UI wherever a person might be about to type one. Exact string, tested. */
export const SEED_PHRASE_GUARANTEE = "CRUCIBLE will never ask for your seed phrase.";

// ── address ──────────────────────────────────────────────────────────────

export type ProblemKind = "error" | "warning";

export interface AddressProblem {
  kind: ProblemKind;
  /** which check produced it, so a call site can point the message at the right field */
  check: "format" | "zero" | "chain";
  message: string;
}

export interface AddressCheck {
  /** true only when there is nothing to say — a warning is not a pass */
  ok: boolean;
  /** the trimmed address, only when the format is a plain one */
  address: `0x${string}` | null;
  problems: AddressProblem[];
}

export interface AddressCheckArgs {
  value: string;
  /** the chain the connected wallet is actually on; null/undefined when nothing is connected */
  connectedChainId?: number | null;
  /** the chain this deployment lives on */
  expectedChainId?: number | null;
  /** the zero address is a burn destination; forms that mean it may opt in */
  allowZeroAddress?: boolean;
}

/**
 * Format first, then network.
 *
 * The order is not cosmetic: a malformed string cannot be compared against a chain, and a
 * form that reported "wrong network" about `0x12` would be describing a problem the reader
 * has already fixed. So a format error short-circuits the network answer.
 */
export function checkAddressTarget(args: AddressCheckArgs): AddressCheck {
  const value = (args.value ?? "").trim();
  const problems: AddressProblem[] = [];

  if (!isEthAddressShape(value)) {
    return {
      ok: false,
      address: null,
      problems: [
        {
          kind: "error",
          check: "format",
          message: "That is not an address. It needs 0x and 40 characters after it.",
        },
      ],
    };
  }

  const address = value as `0x${string}`;

  if (!args.allowZeroAddress && isZeroAddress(value)) {
    problems.push({
      kind: "error",
      check: "zero",
      message: "That address holds nothing — it is the all-zeros address.",
    });
  }

  const { connectedChainId, expectedChainId } = args;
  if (
    typeof connectedChainId === "number" &&
    typeof expectedChainId === "number" &&
    connectedChainId !== expectedChainId
  ) {
    problems.push({
      kind: "warning",
      check: "chain",
      message:
        "Your wallet is on a different network than this forge, so this address is not a thing it can reach here. Switch networks first.",
    });
  }

  return { ok: problems.length === 0, address, problems };
}

/** Plain words for the screen; the check itself is the one this app already uses. */
function isEthAddressShape(value: string): boolean {
  return /^0x[a-fA-F0-9]{40}$/.test(value);
}

function isZeroAddress(value: string): boolean {
  return /^0x0{40}$/.test(value.toLowerCase());
}

// ── seed phrase ──────────────────────────────────────────────────────────

/** Every BIP-39 entropy length, in words. */
const MNEMONIC_LENGTHS = new Set([12, 15, 18, 21, 24]);

/**
 * Function words that the BIP-39 English list does not contain.
 *
 * Their presence in a run means the run is a sentence, not a key. Every word below was
 * checked against the real 2048-entry list (the one `@scure/bip39` ships, read at authoring
 * time — not imported at runtime, see the header) and rejected from it, which is why the set
 * looks odd: "this", "that", "because", "what", "when", "where", "have", "very", "just",
 * "also", "over", "under", "again", "once", "about" and "above" all *are* BIP-39 words, so
 * they are absent here even though they are the most ordinary English imaginable. A word
 * that might be a real entry is left out, because refusing to notice a seed is cheaper than
 * refusing to let someone file a proof.
 */
const PROSE_MARKERS = new Set([
  "the", "and", "but", "not", "for", "nor", "yet", "although", "these", "those",
  "than", "them", "their", "here", "which", "while", "with", "without", "within",
  "onto", "from", "were", "was", "are", "been", "being", "has", "had", "does",
  "did", "done", "your", "yours", "ours", "mine", "its", "him", "her", "she",
  "who", "whom", "why", "how", "too",
]);

/** A BIP-39 English word: three to eight plain letters, nothing else. */
const WORD_SHAPE = /^[a-z]{3,8}$/;

export interface MnemonicHit {
  wordCount: number;
  /** how many words the run started with, kept so the warning can count them back */
  words: string[];
}

/**
 * True when the pasted text contains a run of words shaped exactly like a seed phrase.
 *
 * A run is maximal: it stops at a token that is not word-shaped (a one- or two-letter word,
 * a long technical word, a URL, a number after the punctuation is stripped). So the twelve
 * words of a key pasted behind "my seed is:" still count as a run — "is" is two letters and
 * breaks it — while a paragraph of ordinary English does not, because it is either one run
 * of the wrong length or one that contains a marker word.
 */
export function detectMnemonic(input: string): MnemonicHit | null {
  if (typeof input !== "string" || input.trim() === "") return null;

  const tokens = input
    .toLowerCase()
    .split(/\s+/)
    .map((t) => t.replace(/[^a-z]/g, ""))
    .filter((t) => t.length > 0);

  let run: string[] = [];
  const flush = (): MnemonicHit | null => {
    if (MNEMONIC_LENGTHS.has(run.length) && !run.some((w) => PROSE_MARKERS.has(w))) {
      return { wordCount: run.length, words: [...run] };
    }
    return null;
  };

  for (const token of tokens) {
    if (WORD_SHAPE.test(token)) {
      run.push(token);
      continue;
    }
    const hit = flush();
    if (hit) return hit;
    run = [];
  }
  return flush();
}

/**
 * The paste handler's decision, as data rather than as markup.
 *
 * `refuse` means the text must not reach the field. `warning` is what the field then says —
 * the guard that silently drops a paste is indistinguishable from a broken browser, so the
 * refusal is always spoken.
 */
export function guardPastedText(
  text: string,
): { refuse: false } | { refuse: true; warning: string } {
  const hit = detectMnemonic(text);
  if (!hit) return { refuse: false };
  return {
    refuse: true,
    warning: `That looks like a ${hit.wordCount}-word wallet backup, so it was not pasted here. ${SEED_PHRASE_GUARANTEE}`,
  };
}
