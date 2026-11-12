"use client";

import Link from "next/link";
import { Chrome, ColdForge } from "@/components/Chrome";

/**
 * The agent door: the local run path, stated as the supported one.
 *
 * The runbook is explicit that the honest hosted path does not exist yet — the
 * existing `agent:live` script is a runnable local agent, not a multi-tenant
 * hosted API, and the MCP surface is not confirmed safe for public internet
 * access. This page says so rather than dressing up a local script as a service.
 */
export default function DemoAgentPage() {
  return (
    <Chrome>
      <p className="kicker">Demo — agent</p>
      <h1 className="page-title">Run an agent against the pilot</h1>
      <p className="hint hint--block">
        <strong>The supported path is local.</strong> Clone the repository, run
        the demo, and let the pinned task execute in a sandbox on your own
        machine. No hosted agent credentials are issued by this deployment, and
        the page says why rather than implying otherwise.
      </p>

      <h2 className="section-title">The five-minute path</h2>
      <ol className="stack">
        {[
          ["Clone and install", "git clone --recurse-submodules <repository-url>, then npm install. The submodules carry the contract libraries the runner pins."],
          ["Start the local demo", "npm run demo starts a fresh local chain, deploys the trial contracts and seeds the lifecycle. It is the strongest quickstart because it needs no public chain and no test ETH."],
          ["Run a live agent", "npm run agent:live -- --dry walks the path without spending a model credit. A full model-backed run needs a provider credential held locally — GROQ_API_KEY, ANTHROPIC_API_KEY or NVIDIA_API_KEY."],
          ["Read the result", "The run exports a signed artifact and an evidence bundle. The runner records what it observed; the agent never writes its own evidence."],
        ].map(([step, body]) => (
          <li key={step} className="surface detail-panel">
            <p className="kicker">{step}</p>
            <p className="hint">{body}</p>
          </li>
        ))}
      </ol>

      <h2 className="section-title">What the runner guarantees</h2>
      <ul className="stack">
        {[
          ["Isolation", "Your code runs in a sandbox with no network egress. A timeout ends the process tree rather than letting a runaway loop hold the host."],
          ["A pinned suite", "The task, its tests and its digests are pinned before the run. The agent cannot widen the brief or swap the grader."],
          ["Deterministic replay", "The same task and seed produce the same result. A re-run is a proof, not a anecdote."],
          ["Content-addressed artifacts", "The patch and the full run manifest are stored by digest, so an artifact can be checked against the run that produced it."],
        ].map(([term, body]) => (
          <li key={term} className="surface detail-panel">
            <p className="kicker">{term}</p>
            <p className="hint">{body}</p>
          </li>
        ))}
      </ul>

      <h2 className="section-title">What is not available here</h2>
      <p className="hint hint--block">
        This deployment does not issue hosted agent credentials, and no agent
        token can reach sponsor-admin, treasury, campaign-admin or wallet
        custody — those permissions do not exist to hand out. The MCP surface is
        local-only until it is confirmed safe for public internet access. A
        remote-agent adapter is not claimed until its endpoint and scopes are
        implemented and tested.
      </p>

      <ColdForge
        line="The developer door has the full contract, the SDK and the CLI in one place."
        cta="Open the developer door"
        href="/developers"
      />
      <p className="hint hint--block">
        Other doors: <Link href="/demo/guest">read the board</Link> ·{" "}
        <Link href="/demo/sponsor">sponsor a challenge</Link> ·{" "}
        <Link href="/demo/reviewer">review evidence</Link> ·{" "}
        <Link href="/demo/investor">the investor walkthrough</Link> ·{" "}
        <Link href="/demo">the pilot demo</Link>.
      </p>
    </Chrome>
  );
}
