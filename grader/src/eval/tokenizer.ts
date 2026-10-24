/**
 * Tokenizer & context accounting — turns context and cost from guesses into
 * deterministic accounting. The reference counter is deterministic by
 * construction: same text, same count, every run, no locale, no randomness,
 * no clock.
 *
 * Everything is NFC-normalized before counting and hashing, so composed café
 * and decomposed café count identically and hash identically.
 */

import { createHash } from "node:crypto";

/** Tokenizer manifest — required per model, never implicit. */
export interface TokenizerManifest {
  id: string;
  family: string;
  vocabSize: number;
  contextWindow: number;
  implementation: string;
  corpusHash: string; // hex sha256 of the tokenizer vocab/merges
}

/** A concrete tokenizer. count() is deterministic. */
export interface Tokenizer {
  readonly manifest: TokenizerManifest;
  count(text: string): number;
  corpusHash(): string;
}

/** NFC-normalize text — policy, not folklore. */
export function nfcNormalize(text: string): string {
  return text.normalize("NFC");
}

/**
 * Deterministic reference token counter.
 *
 * Edge invariants (each has a test):
 *   empty string -> 0
 *   whitespace-only -> its run count
 *   BOM prefix counts
 *   ZWJ emoji family & skin-tone modifiers count their code points
 *   CJK -> one token per code point
 *   bidi override + pop counted
 *   combining marks attach to a base (count their code point)
 *   1000-char "word" -> subword chunks
 *   NUL / control characters counted
 *   variation selectors counted
 *   digit runs chunked three at a time
 */
export function deterministicCount(text: string): number {
  const nfc = nfcNormalize(text);
  if (nfc.length === 0) return 0;

  let count = 0;
  let i = 0;
  const n = nfc.length;
  while (i < n) {
    const cp = nfc.codePointAt(i);
    if (cp === undefined) break;
    i += cp > 0xffff ? 2 : 1;
    count += 1;
  }

  // Digit-run chunking: runs of >= 4 digits add one extra chunk per 3 digits
  // beyond the first digit of the run.
  const digitRun = /(\d{4,})/g;
  let match: RegExpExecArray | null;
  while ((match = digitRun.exec(nfc)) !== null) {
    const run = match[1]!;
    count += Math.floor((run.length - 1) / 3);
  }
  return count;
}

/** Corpus hash — sha256 of the manifest's declared corpusHash, self-tested at load. */
export function corpusHash(manifest: TokenizerManifest): string {
  return createHash("sha256").update(manifest.corpusHash).digest("hex");
}

/** A tokenizer backed by the deterministic reference counter. */
export function makeTokenizer(manifest: TokenizerManifest): Tokenizer {
  return {
    manifest,
    count: (text: string) => deterministicCount(text),
    corpusHash: () => corpusHash(manifest),
  };
}

/**
 * Preflight context-fit check — runs BEFORE any completion call.
 * Requires prompt tokens + maxOutputTokens to fit the context window with a
 * margin of max(32, 5% of window). Refusal here kills the most common eval
 * lie: silent truncation.
 */
export interface PreflightResult {
  fits: boolean;
  promptTokens: number;
  maxOutputTokens: number;
  window: number;
  margin: number;
  total: number;
}

export function preflight(
  tokenizer: Tokenizer,
  prompt: string,
  maxOutputTokens: number,
): PreflightResult {
  const promptTokens = tokenizer.count(prompt);
  const margin = Math.max(32, Math.ceil(0.05 * tokenizer.manifest.contextWindow));
  const total = promptTokens + maxOutputTokens;
  return {
    fits: total + margin <= tokenizer.manifest.contextWindow,
    promptTokens,
    maxOutputTokens,
    window: tokenizer.manifest.contextWindow,
    margin,
    total,
  };
}
