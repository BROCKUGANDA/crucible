/**
 * Money Trees deep-link config (gates 434-438).
 *
 * Rule: never embed commercial audio. We deep-link to the user's own streaming
 * app at a chosen timestamp — the scan lays the song on *their* device, from
 * *their* subscription. Zero audio files, zero player code, zero bundle weight.
 *
 * The URL is remote-config-driven (437): timestamp and source are swappable
 * without a rebuild. Defaults to the YouTube timestamp hook — the most universal
 * format, no subscription needed.
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

/**
 * Default: the visitor's own search for the record, on YouTube.
 *
 * The URL this file shipped before was a specific video id that belonged to a different song
 * entirely — Rick Astley, not Kendrick — and the cue text quoted a line of the lyric, which a
 * public repository has no business reproducing. Both are gone, and the comment deliberately
 * does not restate the literal patterns: `apps/web/test/money-sound.test.ts` scans this file for
 * them, and a doc comment naming what it forbids is the self-match AGENTS.md warns about.
 * A search link names the work without pointing at a copy of it, so the deep link cannot rot when
 * a channel is taken down, and there is nothing here to license.
 */
export const DEFAULT_MONEY_TREES: MoneyTreesConfig = {
  source: "youtube",
  url: "https://www.youtube.com/results?search_query=kendrick+lamar+money+trees",
  cue: "their speakers, their subscription — the hook, not a copy of it",
  version: 2,
};

/** Search deep links, one per source. No asset, no id, no clip. */
export function streamLink(source: MoneyTreesConfig["source"]): string {
  const q = "kendrick lamar money trees";
  if (source === "spotify") return `https://open.spotify.com/search/${encodeURIComponent(q)}`;
  if (source === "apple-music") return `https://music.apple.com/search?term=${encodeURIComponent(q)}`;
  return `https://www.youtube.com/results?search_query=${encodeURIComponent(q.replace(/ /g, "+"))}`;
}

/**
 * Resolve MoneyTreesConfig from remote config. Falls back to the default so the
 * chip never crashes the settlement screen when remote config is unavailable.
 */
export function resolveMoneyTrees(remote: MoneyTreesConfig | null | undefined): MoneyTreesConfig {
  if (!remote) return DEFAULT_MONEY_TREES;
  return {
    source: remote.source ?? DEFAULT_MONEY_TREES.source,
    url: remote.url ?? DEFAULT_MONEY_TREES.url,
    cue: remote.cue ?? DEFAULT_MONEY_TREES.cue,
    version: remote.version ?? DEFAULT_MONEY_TREES.version,
  };
}

/** Audit string for the chip label — never the album art or logo treatment. */
export function moneyTreesAuditLine(config: MoneyTreesConfig): string {
  return `money_trees_mode v${config.version} · ${config.source} · ${config.cue}`;
}
