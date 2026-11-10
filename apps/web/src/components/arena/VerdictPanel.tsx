"use client";

import { VerdictStamp } from "./VerdictStamp";

/**
 * VerdictPanel — a consequential verdict display with stamp, label, and rationale.
 *
 * Shows the verdict stamp (paid / slashed / reclaimed), a plain-language label,
 * and the rationale. Distinguishes automated verification from human review and
 * final adjudication. Unknown verdicts render `—`, never a fabricated outcome.
 */
export function VerdictPanel({
  verdict,
  rationale,
  reviewProcess,
}: {
  verdict: "none" | "paid" | "slashed" | "reclaimed";
  rationale: string;
  reviewProcess?: "automated" | "human" | "committee";
}) {
  if (verdict === "none") {
    return (
      <div className="surface verdict-panel" aria-label="Verdict pending">
        <h3 className="verdict-panel__title">Verdict</h3>
        <p className="verdict-panel__label" data-tone="faint">
          —
        </p>
        <p className="verdict-panel__why">No verdict yet. The claim awaits adjudication.</p>
      </div>
    );
  }

  const variant = verdict === "paid" ? "paid" : verdict === "slashed" ? "slashed" : "reclaimed";
  const labels: Record<string, string> = {
    paid: "Verified — the run survived every strike.",
    slashed: "Broken — the skeptic's proof held.",
    reclaimed: "Reclaimed — no run arrived before the deadline.",
  };

  return (
    <div className="surface verdict-panel" aria-label={`Verdict: ${verdict}`} data-tone={variant}>
      <h3 className="verdict-panel__title">Verdict</h3>
      <VerdictStamp variant={variant} width="64" height="64" />
      <p className="verdict-panel__label">{labels[verdict]}</p>
      {reviewProcess && (
        <p className="verdict-panel__process mono">
          {reviewProcess === "automated"
            ? "Machine-checkable evidence."
            : reviewProcess === "human"
              ? "Independent reviewer decision."
              : "Two-of-three Argus committee verdict."}
        </p>
      )}
      <p className="verdict-panel__why">{rationale}</p>
    </div>
  );
}
