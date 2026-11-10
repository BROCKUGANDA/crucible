"use client";

/**
 * StaleDataIndicator — marks data that is cached, historical, or otherwise
 * not live. Every dynamic value identifies its source and state.
 */
export function StaleDataIndicator({ state, lastUpdated }: { state: string; lastUpdated?: string }) {
  return (
    <span className="mono stale-data" data-tone="pending" title={`Data state: ${state}`}>
      {state}{lastUpdated ? ` · updated ${new Date(lastUpdated).toISOString()}` : ""}
    </span>
  );
}
