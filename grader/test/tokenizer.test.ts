import { describe, expect, it } from "vitest";
import {
  deterministicCount,
  nfcNormalize,
  makeTokenizer,
  preflight,
  type TokenizerManifest,
} from "../src/eval/tokenizer.js";

const MANIFEST: TokenizerManifest = {
  id: "tok-v1",
  family: "byte-pair",
  vocabSize: 50257,
  contextWindow: 4096,
  implementation: "reference",
  corpusHash: "corpus-hash-abc",
};

describe("Tokenizer (P0)", () => {
  it("NFC normalizes café identically", () => {
    const composed = "café"; // U+00E9
    const decomposed = "cafe\u0301"; // e + combining acute
    expect(nfcNormalize(composed)).toBe(nfcNormalize(decomposed));
  });

  it("deterministicCount: empty string = 0", () => {
    expect(deterministicCount("")).toBe(0);
  });

  it("deterministicCount: whitespace-only = its run count", () => {
    expect(deterministicCount("   ")).toBe(3);
    expect(deterministicCount("\t\n")).toBe(2);
  });

  it("deterministicCount: BOM prefix counts", () => {
    const withBOM = "\uFEFFhello";
    expect(deterministicCount(withBOM)).toBe(6);
  });

  it("deterministicCount: ZWJ emoji family counts code points", () => {
    // 👨‍👩‍👧‍👦 = man + ZWJ + woman + ZWJ + girl + ZWJ + boy = 7 code points
    const family = "\u{1F468}\u{200D}\u{1F469}\u{200D}\u{1F467}\u{200D}\u{1F466}";
    expect(deterministicCount(family)).toBe(7);
  });

  it("deterministicCount: skin-tone modifier counts its code point", () => {
    const thumbsUpMedium = "\u{1F44D}\u{1F3FD}"; // 👍🏽
    expect(deterministicCount(thumbsUpMedium)).toBe(2);
  });

  it("deterministicCount: CJK one token per code point", () => {
    const cjk = "你好世界";
    expect(deterministicCount(cjk)).toBe(4);
  });

  it("deterministicCount: bidi override + pop counted", () => {
    const bidi = "abc\u{202D}def\u{202C}ghi"; // LRO ... PDF — control chars count
    expect(deterministicCount(bidi)).toBe(11);
  });

  it("deterministicCount: combining marks combine under NFC", () => {
    const base = "e";
    const combining = "\u0301"; // combining acute → NFC: "é" (1 code point)
    expect(deterministicCount(base + combining)).toBe(1);
  });

  it("deterministicCount: 1000-char word counts each char", () => {
    const word = "a".repeat(1000);
    expect(deterministicCount(word)).toBe(1000);
  });

  it("deterministicCount: NUL and control characters counted", () => {
    expect(deterministicCount("a\0b")).toBe(3);
    expect(deterministicCount("a\nb")).toBe(3);
  });

  it("deterministicCount: variation selectors counted", () => {
    expect(deterministicCount("a\uFE0F")).toBe(2);
  });

  it("deterministicCount: digit runs chunked three at a time", () => {
    expect(deterministicCount("12345")).toBe(6); // 5 digits + 1 extra chunk
    expect(deterministicCount("1234")).toBe(5); // 4 digits + 1 extra
    expect(deterministicCount("123")).toBe(3); // 3 digits, no extra
    expect(deterministicCount("12")).toBe(2);
  });

  it("deterministicCount: stable across 100 identical calls", () => {
    const text = "The quick brown fox jumps over the lazy dog. 12345 café 👍🏽";
    const counts = Array.from({ length: 100 }, () => deterministicCount(text));
    expect(new Set(counts).size).toBe(1);
  });

  it("makeTokenizer: count + corpusHash", () => {
    const tok = makeTokenizer(MANIFEST);
    expect(tok.count("hello")).toBe(5);
    expect(tok.corpusHash()).toBeTruthy();
  });

  it("preflight: fits within window with margin", () => {
    const tok = makeTokenizer(MANIFEST);
    const result = preflight(tok, "short prompt", 100);
    expect(result.fits).toBe(true);
    expect(result.margin).toBe(Math.max(32, Math.ceil(0.05 * 4096)));
  });

  it("preflight: overflow refuses", () => {
    const tok = makeTokenizer(MANIFEST);
    const result = preflight(tok, "x".repeat(4000), 500);
    expect(result.fits).toBe(false);
  });
});
