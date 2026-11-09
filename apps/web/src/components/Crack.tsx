"use client";

/**
 * The route-error panel, in its own module on purpose.
 *
 * `global-error.tsx` sits ABOVE the providers, so anything it imports is evaluated in the
 * one context where a stray hook call or a wallet import breaks the crash page itself — the
 * exact hazard that killed prerendering when the root loading state touched the wallet
 * graph. Chrome carries the whole wallet stack, so the crash page imports this file, which
 * imports nothing but React.
 */
export function Crack({ message }: { message: string }) {
  return (
    <div className="surface void-panel">
      <h2 className="void-panel__title" data-tone="sear">
        The crucible cracked.
      </h2>
      <p className="void-panel__body">
        Something broke on our side, not yours. The heat is contained.
      </p>
      <pre className="mono void-panel__trace">{message}</pre>
      <button className="btn btn-primary" onClick={() => location.reload()}>
        Re-ignite
      </button>
    </div>
  );
}
