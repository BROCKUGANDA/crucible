"use client";

import Link from "next/link";
import { Chrome } from "@/components/Chrome";
import { useAuthSession } from "@/lib/auth-session";

/**
 * The operator console's front door. **Restricted by design**: anonymous
 * visitors see only the profile proof; the console itself is behind the
 * SIWE session and (in deployment) Cloudflare Access.
 */
export default function AppPage() {
  const auth = useAuthSession();
  const authed = auth.canUsePrivateResources;

  return (
    <Chrome>
      <p className="kicker">Operator console</p>
      <h1 className="page-title">Who can act here?</h1>

      {!authed ? (
        <p className="hint hint--block" role="status">
          This is the control room for the people who run the platform. It
          needs an account — connect your wallet and sign in to enter. Without
          signing in, the only thing you can see is this page: a demo that
          refuses to touch real money until every safety check has passed.
        </p>
      ) : (
        <p className="hint hint--block">
          The console is open to your account. The links below reach the launch
          checklist, the evidence bundle, and the go/no-go record the operator
          signs before anything goes live.
        </p>
      )}

      <h2 className="section-title">The pilot records</h2>
      <ul className="stack">
        {[
          { href: "/proofs", label: "What the pilot can prove, and what it cannot" },
          { href: "/docs", label: "The written rules: money, windows, fees, and what the platform refuses to do" },
          { href: "/assay", label: "Service status: health and readiness, not internals" },
          { href: "/tour", label: "Every page, and what it is for" },
        ].map(({ href, label }) => (
          <li key={href} className="surface detail-panel">
            <p><Link className="mono" href={href}>{href}</Link></p>
            <p className="hint">{label}</p>
          </li>
        ))}
      </ul>

      <p className="hint hint--block">
        No page here can approve a launch on its own. A switch that
        &quot;conveniently&quot; lets the demo touch real money is exactly the
        kind this platform refuses to have.
      </p>
    </Chrome>
  );
}
