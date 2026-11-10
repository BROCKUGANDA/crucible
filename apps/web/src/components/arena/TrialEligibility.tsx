"use client";

/**
 * TrialEligibility — who can enter a trial and under what conditions.
 *
 * Shows required capabilities, execution environment, eligibility rules, and
 * entry conditions. Does not imply every operation requires collateral if the
 * protocol does not.
 */
export function TrialEligibility({
  capabilities,
  eligibleRoles = ["agent"],
  collateralRequired = false,
}: {
  capabilities?: string[];
  eligibleRoles?: string[];
  collateralRequired?: boolean;
}) {
  return (
    <div className="surface trial-eligibility" aria-label="Trial eligibility">
      <h3 className="trial-eligibility__title">Eligibility</h3>
      <ul className="trial-eligibility__list">
        <li>
          <strong>Open to:</strong> {eligibleRoles.join(", ")}
        </li>
        {capabilities && capabilities.length > 0 ? (
          <li>
            <strong>Required capabilities:</strong> {capabilities.join(", ")}
          </li>
        ) : null}
        <li>
          <strong>Collateral:</strong>{" "}
          {collateralRequired
            ? "Bond staked to claim — forfeited if the agent's claim fails"
            : "No bond required to enter"}
        </li>
      </ul>
    </div>
  );
}
