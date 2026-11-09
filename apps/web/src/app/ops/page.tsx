"use client";

import Link from "next/link";
import { Chrome } from "@/components/Chrome";

/**
 * The ops surface: deployment profile and chain proofs, then the pilot
 * reports. Public about the deployment, private about everything else — the
 * console behind it is the operator's, never the internet's.
 */
export default function OpsPage() {
  return (
    <Chrome>
      <p className="kicker">Ops — pilot profile and proofs</p>
      <h1 className="page-title">This deployment, named</h1>
      <p className="hint hint--block">
        Profile: <span className="mono">demo</span> — the demo escrow holds test
        ETH worth nothing on a local development chain. Preview and production
        refuse to boot until their own gates exist; that refusal is the security
        control, not a workaround.
      </p>

      <div className="metric-grid">
        <p className="surface detail-panel">
          <strong>Chain.</strong> The demo runs <span className="mono">31337</span> — the
          local Anvil chain. The chain ID is proven against the RPC server-side,
          not trusted from browser config.
        </p>
        <p className="surface detail-panel">
          <strong>Real value?</strong> <span className="mono">REAL_VALUE_OPERATIONS=0</span>.
          No real-value transaction path is reachable from this profile.
        </p>
        <p className="surface detail-panel">
          <strong>Who operates it?</strong> The named operator signs the
          go/no-go record. This page is never a substitute for that signature.
        </p>
      </div>

      <h2 className="section-title">The records</h2>
      <ul className="stack">
        {[
          { href: "/proofs", label: "What the pilot can prove, and what it cannot" },
          { href: "/docs", label: "The written rules, and what the platform refuses to do" },
          { href: "/assay", label: "Service status" },
          { href: "/app", label: "The operator console (restricted)" },
        ].map(({ href, label }) => (
          <li key={href} className="surface detail-panel">
            <p><Link className="mono" href={href}>{href}</Link></p>
            <p className="hint">{label}</p>
          </li>
        ))}
      </ul>
    </Chrome>
  );
}
