"use client";

/**
 * ReviewerDecision — a single Argus seat's decision.
 *
 * Shows the seat, the decision, and whether it is sealed (commit) or revealed.
 * Preserves reviewer independence: unrevealed decisions are not inspectable by
 * other reviewers. Unknown decisions render "—".
 */
export function ReviewerDecision({
  seat,
  decision,
  revealed,
}: {
  seat: number;
  decision: "uphold" | "overturn" | null;
  revealed: boolean;
}) {
  const label =
    decision === "uphold"
      ? "Uphold the claim"
      : decision === "overturn"
        ? "Overturn the claim"
        : "—";

  return (
    <div className="surface reviewer-decision" aria-label={`Seat ${seat} decision`}>
      <p className="reviewer-decision__seat mono">Seat {seat}</p>
      <p className="reviewer-decision__decision" data-tone={decidedTone(decision)}>
        {revealed ? label : "Sealed"}
      </p>
      {!revealed && (
        <p className="reviewer-decision__note">Commit-reveal: decision sealed until reveal window.</p>
      )}
    </div>
  );
}

function decidedTone(decision: "uphold" | "overturn" | null) {
  if (decision === "uphold") return "quench";
  if (decision === "overturn") return "sear";
  return "faint";
}
