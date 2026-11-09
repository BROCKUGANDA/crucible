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
          The operator console is behind a session. What is true without one: this
          deployment is profile-gated by <span className="mono">CRUCIBLE_PROFILE</span>{" "}
          and refuses <span className="mono">preview</span> and{" "}
          <span className="mono">production</span> until their gates exist.
          Sign in to read the rest.
        </p>
      ) : (
        <p className="hint hint--block">
          The console is open to this session. The links below reach the rollout
          checklist, the evidence bundle, and the go/no-go record the named
          operator signs.
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
        No page here can mint an approval. A profile switch that &quot;works&quot; is a
        profile switch that can point a demo at mainnet.
      </p>
    </Chrome>
  );
}
