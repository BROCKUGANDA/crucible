"use client";

import { useCallback } from "react";
import { resolveMoneyTrees, type MoneyTreesConfig } from "@/lib/frenchy/money-trees";

interface MoneyTreesChipProps {
  /** Remote config override (437) — any subset; what it omits is derived. */
  remote?: Partial<MoneyTreesConfig> | null;
  /** Whether the first payout has landed (showtime mode). */
  settled: boolean;
  /** Optional click handler override for tests. */
  onCue?: (url: string) => void;
}

/**
 * Gate 434 — "CUE IT" deep-link chip on the settlement celebration screen.
 *
 * Link-out only: opens the Money Trees deep link in a new tab. Zero embedded
 * audio, no player code, no autoplay-policy fight, no Content ID exposure
 * (gate 438). The song plays on the user's device, from their subscription.
 */
export function MoneyTreesChip({
  remote,
  settled,
  onCue,
}: MoneyTreesChipProps): React.ReactElement | null {
  const config = resolveMoneyTrees(remote);
  // Hooks run before the early return: `useCallback` after `if (!settled) return null`
  // is a rules-of-hooks violation that happens to work only while `settled` never
  // flips within a mount — exactly the kind of latent crash a lint pass exists to catch.
  const handleClick = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      try {
        window.open(config.url, "_blank", "noopener,noreferrer");
      } catch {
        /* popup blocked: fall back to same-tab navigation */
        window.location.assign(config.url);
      }
      onCue?.(config.url);
    },
    [config.url, onCue],
  );

  if (!settled) return null;

  return (
    <a
      href={config.url}
      target="_blank"
      rel="noopener noreferrer"
      onClick={handleClick}
      className="btn btn-ghost btn-sm money-trees-chip"
      title={`Cue it up — ${config.cue} (opens in your ${config.source} app)`}
      aria-label={`CUE IT — ${config.cue}`}
    >
      CUE IT
    </a>
  );
}
