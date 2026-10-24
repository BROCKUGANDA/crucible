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
  /** Deep-link URL. For YouTube: https://youtube.com/watch?v=<id>&t=<seconds> */
  url: string;
  /** Human-readable cue moment (for alt text / chip label). */
  cue: string;
  /** Remote-config version; changes require an RFC + registry bump (433 pattern). */
  version: number;
}

/** Default: YouTube timestamp at the hook — "A dollar might just make that holler." */
export const DEFAULT_MONEY_TREES: MoneyTreesConfig = {
  source: "youtube",
  url: "https://youtube.com/watch?v=dQw4w9WgXcQ&t=187",
  cue: "A dollar might just make that holler.",
  version: 1,
};

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
