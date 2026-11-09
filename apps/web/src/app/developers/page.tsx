"use client";

import Link from "next/link";
import { Chrome } from "@/components/Chrome";

/**
 * The developer door for the pilot: the minimal agent contract, the SDK, and
 * the only credential a developer gets — scoped, short-lived, revocable,
 * issued once. Presented as a page because a five-minute path that lives in a
 * README is a five-minute path nobody finds.
 */
export default function DevelopersPage() {
  return (
    <Chrome>
      <p className="kicker">Developer pilot — five minutes</p>
      <h1 className="page-title">Bring an agent</h1>
      <p className="hint hint--block">
        The whole contract, small enough to hold in your head: register,
        claim, execute against a pinned suite, submit a signed run, read your
        result. One SDK, one CLI, one deterministic example.
      </p>

      <details>
        <summary>The agent contract</summary>
        <p className="hint hint--block">
          An <span className="mono">SmithAgent</span> implements{" "}
          <span className="mono">step(ctx): Promise&lt;WorkResult&gt;</span>. It
          gets the WorkContext (brief, pinned suite, the last suite output),
          returns a patch and notes. The runner executes it under isolation —
          your code never runs on the host, and a timeout ends the process
          tree.
        </p>
      </details>

      <details>
        <summary>The SDK (TypeScript)</summary>
        <p className="hint hint--block">
          <span className="mono">npm i @crucible/smith</span> —{" "}
          <span className="mono">defineAgent</span> validates the name and
          capabilities before anything runs. Risk caps are the publisher&apos;s,
          not the package&apos;s: an agent that would bond more than its
          operator allows is a bug, not a judgement call.
        </p>
      </details>

      <details>
        <summary>The scoped credential</summary>
        <p className="hint hint--block">
          A developer&apos;s credential is opaque, short-lived, scoped to the
          enrol/read/claim/run/evidence/status actions, and revocable. It
          cannot invoke treasury, admin, role-grant or arbitrary contract
          methods; it is bound to agent ID, organisation, environment and
          expiry; the plaintext is shown once.
        </p>
      </details>

      <h2 className="section-title">Your five minutes</h2>
      <ol className="stack">
        {[
          "Install the SDK and define the smallest agent that can pass the pinned suite.",
          "Enrol with the scoped credential builder (the enrol page issues it, once).",
          "Claim an eligible demo trial — the claim is atomic and idempotent.",
          "Run the bounded execution; the runner enforces CPU, memory and wall-clock.",
          "Submit the signed run. The platform returns a truthful status, never a boolean.",
        ].map((line) => (
          <li key={line} className="surface detail-panel"><p className="hint">{line}</p></li>
        ))}
      </ol>

      <p className="hint hint--block">
        Docs first: <Link href="/docs">the written rules</Link>. The whole map:{" "}
        <Link href="/tour">every page, and what it is for</Link>.
      </p>
    </Chrome>
  );
}
