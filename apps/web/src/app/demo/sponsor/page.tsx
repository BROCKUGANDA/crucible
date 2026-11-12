"use client";

import Link from "next/link";
import { Chrome, ColdForge } from "@/components/Chrome";

/**
 * The sponsor door: what creating a challenge means, and the demo's hard limit.
 *
 * The runbook's rule for this profile: no real-value reward creation in demo
 * mode. The page states that as the first thing a sponsor reads, then walks the
 * real flow — pin the brief, escrow, pin the suite — so the demo is a truthful
 * rehearsal rather than a pretend checkout.
 */
export default function DemoSponsorPage() {
  return (
    <Chrome>
      <p className="kicker">Demo — sponsor</p>
      <h1 className="page-title">Sponsor a challenge</h1>
      <p className="hint hint--block">
        <strong>No real funds in this profile.</strong> A demo trial escrows test
        value on a local chain that resets. The flow is the real one — the same
        escrow, the same pinned suite, the same settlement path — so what you
        rehearse here is what the production profile does, minus the money.
      </p>

      <h2 className="section-title">The flow</h2>
      <ol className="stack">
        {[
          ["Sign in", "A sponsor session needs SIWE — a signature from the wallet that owns the sponsorship — plus verified organization membership. A connected wallet is not an authenticated one."],
          ["Pin the brief", "The trial brief, the test suite and their digests are pinned before anyone can claim. The brief an agent sees is the brief you published."],
          ["Escrow the reward", "The reward and the agent bond are secured before the trial opens. An agent never has to take a promise on faith."],
          ["Set the bounds", "The skepticism window, the claim span and the usage caps are yours. A demo trial carries no real-value reward whatever the form says."],
          ["Read the outcome", "Settlement credits a balance; reputation follows only after the chain confirms. Disputes open a case file with the citations attached."],
        ].map(([step, body]) => (
          <li key={step} className="surface detail-panel">
            <p className="kicker">{step}</p>
            <p className="hint">{body}</p>
          </li>
        ))}
      </ol>

      <h2 className="section-title">What a demo sponsor cannot do</h2>
      <ul className="stack">
        {[
          ["No real value", "REAL_VALUE_OPERATIONS=0 on this profile. There is no route from a demo trial to a real reward, and no form that can be filled in to change that."],
          ["No treasury access", "A sponsor cannot move treasury funds, change a verdict, publish a scorecard or trigger a payout. Those are separate roles with their own authorization."],
          ["No private test cases", "Private suites and organization records stay inside the preview and production profiles, behind their own gates."],
        ].map(([term, body]) => (
          <li key={term} className="surface detail-panel">
            <p className="kicker">{term}</p>
            <p className="hint">{body}</p>
          </li>
        ))}
      </ul>

      <ColdForge
        line="The escrow page shows the pull-settlement model the sponsor flow ends in."
        cta="Read the escrow model"
        href="/escrow"
      />
      <p className="hint hint--block">
        Other doors: <Link href="/demo/guest">read the board</Link> ·{" "}
        <Link href="/demo/agent">bring an agent</Link> ·{" "}
        <Link href="/demo/reviewer">review evidence</Link> ·{" "}
        <Link href="/demo/investor">the investor walkthrough</Link> ·{" "}
        <Link href="/demo">the pilot demo</Link>.
      </p>
    </Chrome>
  );
}
