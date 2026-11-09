"use client";

import { UNKNOWN } from "@/lib/clock";

/**
 * An API result, shown as rows instead of a wall of JSON.
 *
 * The console pages (rewards, solana, finance, data, engineering) each printed the
 * whole response with `JSON.stringify` — a reader could not scan it and a screen reader
 * read punctuation. Top-level scalar fields render as rows; anything structured is
 * summarised and the exact bytes stay available behind "Raw payload", because an
 * operator debugging a refusal needs the response verbatim.
 *
 * A null field prints the unknown glyph, never "null": the display rule applies to a
 * payload dump exactly as it does to a figure on a card.
 */
export function Payload({ value, title = "Result" }: { value: unknown; title?: string }) {
  if (value === null || value === undefined) return null;

  const raw = (
    <details className="payload__raw">
      <summary className="hint">Raw payload</summary>
      <pre className="code">{JSON.stringify(value, null, 2)}</pre>
    </details>
  );

  if (typeof value !== "object" || Array.isArray(value)) {
    return (
      <div className="surface detail-panel">
        <h2 className="section-title">{title}</h2>
        {raw}
      </div>
    );
  }

  const rows = Object.entries(value as Record<string, unknown>);
  return (
    <div className="surface detail-panel">
      <h2 className="section-title">{title}</h2>
      <dl className="payload">
        {rows.map(([key, entry]) => (
          <div key={key} className="payload__row">
            <dt className="kicker">{key}</dt>
            <dd className="mono">{renderValue(entry)}</dd>
          </div>
        ))}
      </dl>
      {raw}
    </div>
  );
}

/** A scalar prints itself; a structure names its shape rather than pretending to be one. */
function renderValue(entry: unknown): string {
  if (entry === null || entry === undefined) return UNKNOWN;
  if (Array.isArray(entry)) return entry.length === 0 ? UNKNOWN : `${entry.length} item${entry.length === 1 ? "" : "s"}`;
  if (typeof entry === "object") return "structured — see raw payload";
  return String(entry);
}
