"use client";

import { useCountdown } from "@/lib/useSnapshot";
import { deadlineHeat, formatDuration, heatTone } from "@/lib/forge";

/**
 * TrialCountdown — a deadline countdown anchored to the chain clock, not the browser clock.
 *
 * Shows time remaining until the submission deadline or, once judging, until the skeptic
 * window closes. Tone reflects deadline heat (ember imminent, gold soon, dim far).
 * Null/unknown deadlines render `—`, never `0`.
 */
export function TrialCountdown({
  deadlineAt,
  breakWindowEndsAt,
  status,
  label,
  chainNowMs,
}: {
  deadlineAt: number | null | undefined;
  breakWindowEndsAt: number | null | undefined;
  status: string;
  label?: string;
  /**
   * Anchor for the countdown: `max(headTimestamp + 1, serverNow)` from the snapshot,
   * not a browser clock. Null falls back to the wall clock — the same behaviour the
   * rows had before the anchor was threaded, kept so a caller without a snapshot
   * (a storybook-shaped fixture) does not go dark.
   */
  chainNowMs?: number | null;
}) {
  // The countdown hook anchors to the chain clock when the caller hands it over.
  const cools = useCountdown(deadlineAt ?? null, chainNowMs ?? null);
  const breakLeft = useCountdown(breakWindowEndsAt ?? null, chainNowMs ?? null);

  const onBreakWindow = status === "judging" && breakLeft !== null;
  const remaining = onBreakWindow ? breakLeft : cools;
  const heat = remaining !== null ? deadlineHeat(remaining) : null;

  // If we never got a chain anchor, say unknown — never print a browser-clock number as if
  // it were chain time.
  const unknown = remaining === null && heat === null;

  return (
    <span
      className="mono"
      data-tone={heat ? heatTone(heat) : "faint"}
      title={label ?? (onBreakWindow ? "Skeptic window closes" : "Submission deadline")}
    >
      {unknown ? "—" : onBreakWindow ? `break window ${formatDuration(remaining)}` : `deadline ${formatDuration(remaining)}`}
    </span>
  );
}
