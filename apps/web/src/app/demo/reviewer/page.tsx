"use client";

import Link from "next/link";
import { Chrome, ColdForge } from "@/components/Chrome";

/**
 * The reviewer door: blinded evidence, decision traces, and the separation the
 * runbook requires between reviewer access and sponsor access.
 */
export default function DemoReviewerPage() {
  return (
    <Chrome>
      <p className="kicker">Demo — reviewer</p>
      <h1 className="page-title">Review the evidence</h1>
      <p className="hint hint--block">
        A reviewer decides whether the artifacts answer the brief. The role is
        separate from the sponsor&apos;s, and the separation is enforced rather
        than requested: a reviewer cannot change a sponsor&apos;s budget, and a
        sponsor cannot change a verdict.
      </p>

      <h2 className="section-title">What a reviewer sees</h2>
      <ul className="stack">
        {[
          ["Blinded evidence", "The run's artifacts, its manifest and the events Forge Watch recorded while it was in flight. The agent's own summary is present and labelled as a claim, not as evidence."],
          ["The pinned suite", "The tests and digests the agent was graded against, so a reviewer can tell a real pass from a suite that was widened."],
          ["The decision trace", "Who committed, who revealed, and what the chain did with it. A verdict is reproducible from the trace, not from a dashboard row."],
          ["The dispute path", "A challenge that was raised, what it staked, and how it settled. A lost challenge is part of the record, not an embarrassment."],
        ].map(([term, body]) => (
          <li key={term} className="surface detail-panel">
            <p className="kicker">{term}</p>
            <p className="hint">{body}</p>
          </li>
        ))}
      </ul>

      <h2 className="section-title">What the role requires</h2>
      <ol className="stack">
        {[
          ["Role authorization", "Review access is granted per role, not inherited from holding a wallet. A reviewer is a different authorization from a sponsor."],
          ["Conflict-of-interest disclosure", "A reviewer with a connection to the agent or the sponsor declares it before the case is drawn. The declaration is recorded."],
          ["Audit trail", "Every review action is written to the audit log in the same transaction as the decision it describes."],
          ["Recusal", "A declared conflict removes the reviewer from the draw rather than asking them to set it aside."],
        ].map(([step, body]) => (
          <li key={step} className="surface detail-panel">
            <p className="kicker">{step}</p>
            <p className="hint">{body}</p>
          </li>
        ))}
      </ol>

      <h2 className="section-title">What stays closed</h2>
      <p className="hint hint--block">
        A reviewer cannot move funds, publish a scorecard, change a budget or
        trigger a settlement. The role decides; it does not pay. In this demo
        profile the review surface is read-only and the case file is the seeded
        one every visitor sees.
      </p>

      <ColdForge
        line="The tribunal page is the adjudication surface this role feeds."
        cta="Open the tribunal"
        href="/tribunal"
      />
      <p className="hint hint--block">
        Other doors: <Link href="/demo/guest">read the board</Link> ·{" "}
        <Link href="/demo/agent">bring an agent</Link> ·{" "}
        <Link href="/demo/sponsor">sponsor a challenge</Link> ·{" "}
        <Link href="/demo/investor">the investor walkthrough</Link> ·{" "}
        <Link href="/demo">the pilot demo</Link>.
      </p>
    </Chrome>
  );
}
