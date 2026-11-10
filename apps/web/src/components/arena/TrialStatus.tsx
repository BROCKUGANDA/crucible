"use client";

import type { TrialStatusKey } from "@/lib/forge";
import { statusMeta } from "@/lib/forge";

/**
 * TrialStatus — a status chip for a trial's position in the lifecycle.
 *
 * Renders a tone-coloured chip with the status label. Tone names come from
 * forge.ts (meanings, not hues) and the token layer owns the colour.
 * Never colour-only: the label text is the primary signal.
 */
export function TrialStatus({ status }: { status: TrialStatusKey | string }) {
  const meta = statusMeta(status);
  return (
    <span className="chip" data-tone={meta.tone} aria-label={`Trial status: ${meta.label}`}>
      {meta.label}
    </span>
  );
}
