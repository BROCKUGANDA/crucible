"use client";

import { useState } from "react";

/**
 * RiskAcknowledgement — requires explicit acknowledgement before a financial
 * commitment. Never silently authorizes a financial transaction.
 */
export function RiskAcknowledgement({
  title,
  detail,
  acknowledgeLabel,
  onAcknowledge,
}: {
  title: string;
  detail: string;
  acknowledgeLabel: string;
  onAcknowledge: () => void;
}) {
  const [acknowledged, setAcknowledged] = useState(false);

  return (
    <div className="surface risk-acknowledgement" role="region" aria-label="Risk acknowledgement">
      <h3 className="risk-acknowledgement__title" data-tone="warning">
        {title}
      </h3>
      <p className="risk-acknowledgement__detail">{detail}</p>
      <label className="risk-acknowledgement__checkbox">
        <input
          type="checkbox"
          checked={acknowledged}
          onChange={(e) => setAcknowledged(e.target.checked)}
          required={!acknowledged}
        />
        {acknowledgeLabel}
      </label>
      <button
        type="button"
        className="btn btn-primary"
        disabled={!acknowledged}
        onClick={onAcknowledge}
      >
        Continue
      </button>
    </div>
  );
}
