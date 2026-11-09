"use client";

import { Chrome } from "@/components/Chrome";

/**
 * The pilot's honest ledger: what the pilot can prove, what it cannot, and
 * which limitations stay on the page because hiding them would be a lie.
 * Every non-functional or simulated feature here is named, not omitted.
 */
export default function ProofsPage() {
  return (
    <Chrome>
      <p className="kicker">Proofs — and limits</p>
      <h1 className="page-title">What this pilot can prove</h1>
      <p className="hint hint--block">
        Read this page first when a number on another page looks too good. This
        deployment is a **demonstration on a local development chain**; the
        contracts are unaudited; nothing here should be relied on as a legal,
        financial or regulatory control.
      </p>

      <h2 className="section-title">Proven on this deployment</h2>
      <ul className="stack">
        <li className="surface detail-panel"><p className="hint">Settlements credit a pull ledger; no settlement pushes ETH.</p></li>
        <li className="surface detail-panel"><p className="hint">The fee is 5% (500 bps), deducted from the agent&apos;s payout at settlement — never 15%.</p></li>
        <li className="surface detail-panel"><p className="hint">Authorization is checked server-side on every route; hiding a link is never a permission system.</p></li>
        <li className="surface detail-panel"><p className="hint">Run artifacts are EIP-712 signed and bound to trial, agent, run hash and deadline.</p></li>
      </ul>

      <h2 className="section-title">Not proven — named, not hidden</h2>
      <ul className="stack">
        <li className="surface detail-panel"><p className="hint">No independent audit; the contracts are non-upgradeable and carry no pause or recovery path.</p></li>
        <li className="surface detail-panel"><p className="hint">The indexer is in-memory and single-node — a restart loses indexed state until re-read.</p></li>
        <li className="surface detail-panel"><p className="hint">Forge Watch telemetry is durable where the host wires it, but the live chain can be silent; announcements never imply a payment.</p></li>
        <li className="surface detail-panel"><p className="hint">BYOA execution isolation is strong but not hostile-code containment; the demo profiles carry allowlisted execution.</p></li>
        <li className="surface detail-panel"><p className="hint">The Engram Merkle claim path is wired, the EngramLocker deliberately refuses lock/unlock, and no staking/ownership input ever improves a verdict.</p></li>
      </ul>

      <p className="hint hint--block">
        What fails, fails loudly: a payment that never landed is pending, not paid;
        a proof that cannot be checked publishes &ldquo;—&rdquo;, never 0.
      </p>
    </Chrome>
  );
}
