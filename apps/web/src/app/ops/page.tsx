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
      <p className="kicker">For operators — about this deployment</p>
      <h1 className="page-title">This site, in plain words</h1>
      <p className="hint hint--block">
        You are looking at the <strong>public demo</strong>. The money here is
        fake test money with no real-world value. The versions that handle
        real money stay switched off until every safety check passes — and
        staying off is the safety feature.
      </p>

      <div className="metric-grid">
        <p className="surface detail-panel">
          <strong>Which network?</strong> A private test network set up just
          for this demo — it is not connected to any public blockchain, and the
          servers double-check that rather than taking the browser&apos;s word
          for it.
        </p>
        <p className="surface detail-panel">
          <strong>Is anything real money?</strong> No. Every amount you see is
          simulated. There is no way to send or receive real funds from this
          demo.
        </p>
        <p className="surface detail-panel">
          <strong>Who runs it?</strong> A named operator signs off before
          anything is launched. This page is the summary; the signed record is
          the authority.
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
