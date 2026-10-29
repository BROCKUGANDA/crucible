/**
 * Money Trees deep-link config (gates 434-438, 904).
 *
 * Rule: never embed commercial audio. The chip links out to the visitor's own search for the
 * record, so the song plays on *their* device, from *their* subscription — zero audio files,
 * zero player code, zero bundle weight, and nothing in this repository to license.
 *
 * The link is remote-config-driven (437): source, url and cue are swappable without a rebuild.
 * An override may name any subset, and what it does not name is derived — so a chip told to
 * speak on another service never falls back to a YouTube page.
 */

export interface MoneyTreesConfig {
  /** "youtube" | "spotify" | "apple-music" */
  source: "youtube" | "spotify" | "apple-music";
  /**
   * Deep-link URL. A search for the work, never a specific recording: an id is a claim about
   * someone else's upload that this repository cannot verify and cannot license.
   */
  url: string;
  /** Human-readable cue moment (for alt text / chip label). */
  cue: string;
  /** Remote-config version; changes require an RFC + registry bump (433 pattern). */
  version: number;
}

/** The record the chip names. Search terms, never a recording. */
const MONEY_TREES_TERMS = "kendrick lamar money trees";

/**
 * The search deep link for a source — the only place these URLs are written.
 *
 * This file once shipped a specific video id belonging to a different song entirely, with a cue
 * that quoted the lyric. Neither is restated here, on purpose: `apps/web/test/money-sound.test.ts`
 * scans this source for the old id and for a recording-link shape, and a doc comment that names
 * what its own gate forbids is the self-match AGENTS.md warns about. A search names the work
 * without pointing at a copy of it, so the link cannot rot when a channel is taken down and there
 * is nothing here to license.
 */
export function streamLink(source: MoneyTreesConfig["source"]): string {
  const terms = encodeURIComponent(MONEY_TREES_TERMS);
  if (source === "spotify") return `https://open.spotify.com/search/${terms}`;
  if (source === "apple-music") return `https://music.apple.com/search?term=${terms}`;
  return `https://www.youtube.com/results?search_query=${terms}`;
}

/** Default: the visitor's own search for the record, on YouTube. */
export const DEFAULT_MONEY_TREES: MoneyTreesConfig = {
  source: "youtube",
  url: streamLink("youtube"),
  cue: "their speakers, their subscription — the hook, not a copy of it",
  version: 3,
};

/**
 * Resolve a remote-config override. Remote config names whatever it names, so every field falls
 * back on its own — a source with no url gets that source's search link, not the default one.
 */
export function resolveMoneyTrees(remote?: Partial<MoneyTreesConfig> | null): MoneyTreesConfig {
  const source = remote?.source ?? DEFAULT_MONEY_TREES.source;
  return {
    source,
    // `||` rather than `??`: an override that answers with an empty string has no link, and an
    // empty href is a chip that goes nowhere.
    url: remote?.url || streamLink(source),
    cue: remote?.cue ?? DEFAULT_MONEY_TREES.cue,
    version: remote?.version ?? DEFAULT_MONEY_TREES.version,
  };
}
