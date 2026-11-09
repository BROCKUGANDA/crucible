"use client";

import { useCountdown } from "@/lib/useSnapshot";
import { deadlineHeat, formatDuration, heatTone } from "@/lib/forge";
import { useState } from "react";

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
}: {
  deadlineAt: number | null | undefined;
  breakWindowEndsAt: number | null | undefined;
  status: string;
  label?: string;
}) {
  const [chainNowMs] = useState<number | null>(null);

  // The countdown hook anchors to max(headTimestamp + 1, serverNow) — the node's own clock.
  // We read it lazily; a null anchor renders unknown rather than fabricating a number.
  const cools = useCountdown(deadlineAt ?? null, chainNowMs);
  const breakLeft = useCountdown(breakWindowEndsAt ?? null, chainNowMs);

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
