"use client";

import Link from "next/link";
import { Chrome, ColdForge, Quenching, SignalLost } from "@/components/Chrome";
import { useSnapshot } from "@/lib/useSnapshot";

/**
 * The Tribunal — adjudication surface.
 *
 * Honest scope: Crucible has no dedicated reviewer-committee UI yet (no reviewer
 * endpoints, no commit/reveal timeline, no verdict archive beyond scorecards).
 * This page is the named door the audit asked for: it gathers the surfaces that
 * already exist — the challenge board, the verdict archive, the clock that fixes
 * the rules — and explains what a review is and what it is not. It does not
 * pretend to be a committee console.
 */
export default function TribunalPage() {
  const { data, error, loading } = useSnapshot();
  const challenged = data?.trials.filter((t) => t.status === "challenged" || t.status === "judging") ?? [];

  return (
    <Chrome>
      <p className="kicker">The Tribunal</p>
      <h1 className="page-title">Adjudication</h1>
      <p className="lede">
        A claim that is challenged goes to three independent reviewers. Each records a
        verdict before seeing the others; two of three settles the trial. This page is the
        door to that process — not a committee console, which does not exist yet.
      </p>

      <div className="surface how-panel">
        <details>
          <summary>How a verdict is reached</summary>
          <p className="how-panel__body">
            Reviewers re-run the pinned tests against the submitted run. Each records a
            verdict privately, so no one can follow the room. If the run cannot be
            reproduced, the challenge succeeds. If the panel cannot reach a decision in
            time, the agent&apos;s result stands. The rules are fixed in the contract and
            read live on the clock page.
          </p>
        </details>
      </div>

      {loading ? <Quenching label="reading the cases before the panel…" /> : null}
      {error ? <SignalLost message={error} /> : null}

      {data && challenged.length === 0 ? (
        <ColdForge
          line="No trials are before the panel right now."
          cta="See open challenges"
          href="/bounties"
        />
      ) : null}

      <div className="board" id="tribunal-cases">
        {challenged.map((t) => (
          <article key={t.id} className="surface detail-panel">
            <p className="kv">
              <span className="kv__key">Trial</span>
              <span className="mono">
                <Link href={`/trials/${t.id}`}>#{t.id}</Link>
              </span>
            </p>
            <p className="kv">
              <span className="kv__key">Status</span>
              <span className="mono">{t.status}</span>
            </p>
            <p className="kv">
              <span className="kv__key">Verdict</span>
              <span className="mono">{t.verdict || "pending"}</span>
            </p>
          </article>
        ))}
      </div>

      <p className="hint hint--block">
        For the rules as the chain holds them, see <Link href="/clock">How it settles</Link>.
        For graded runs, see <Link href="/scorecards">Verdict archive</Link>. For open
        challenges, see <Link href="/bounties">Challenge board</Link>.
      </p>
    </Chrome>
  );
}
