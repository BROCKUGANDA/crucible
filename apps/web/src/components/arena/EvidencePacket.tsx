"use client";

/**
 * EvidencePacket — the evidence bundle for a trial claim or challenge.
 *
 * Lists evidence items with source, timestamp, and verification status. Each
 * item links to its artifact. Unknown verification status renders "Unverified",
 * never a fabricated pass/fail.
 */
interface EvidenceItem {
  id: string;
  type: string;
  source: string;
  timestamp: string | null;
  verified: boolean | null;
  artifactUrl: string | null;
}

export function EvidencePacket({ items }: { items: EvidenceItem[] }) {
  if (items.length === 0) {
    return (
      <div className="surface evidence-packet" aria-label="Evidence packet">
        <h3 className="evidence-packet__title">Evidence packet</h3>
        <p className="evidence-packet__empty">No evidence submitted yet.</p>
      </div>
    );
  }

  return (
    <div className="surface evidence-packet" aria-label="Evidence packet">
      <h3 className="evidence-packet__title">Evidence packet</h3>
      <ul className="evidence-packet__list">
        {items.map((item) => (
          <li key={item.id} className="evidence-packet__item">
            <div className="evidence-packet__item__head">
              <span className="mono evidence-packet__item__type">{item.type}</span>
              <span className="evidence-packet__item__source">{item.source}</span>
            </div>
            <p className="evidence-packet__item__time mono">
              {item.timestamp ? new Date(item.timestamp).toISOString() : "—"}
            </p>
            {item.artifactUrl ? (
              <a href={item.artifactUrl} className="evidence-packet__item__link">
                View artifact
              </a>
            ) : null}
            <span
              className="evidence-packet__item__status mono"
              data-tone={item.verified === true ? "quench" : item.verified === false ? "sear" : "faint"}
            >
              {item.verified === true ? "Verified" : item.verified === false ? "Failed" : "Unverified"}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}
