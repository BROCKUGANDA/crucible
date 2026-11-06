"use client";

import Link from "next/link";
import { useParams } from "next/navigation";
import { useEffect, useState } from "react";
import { Chrome, ColdForge, Quenching, SignalLost } from "@/components/Chrome";
import { API_BASE } from "@/lib/apiBase";
import {
  asReproduction,
  copyFor,
  detailEntries,
  toneFor,
  type Reproduction,
} from "@/lib/reproduce/view";

/**
 * Reproducing one run, in the browser.
 *
 * The API behind this (`GET /api/reproduce/:trialId`) re-derives a published run from the node,
 * the content store and the disclosure log — never from the indexer's read model. This page is
 * the same read with a shape a person can follow: five bindings, each shown with the number a
 * reader can go and check for themselves, and each stating plainly what was compared to what.
 *
 * Why this is a page and not just an endpoint: the claim being made is "you do not have to trust
 * us", and a claim like that is worth nothing if the only way to test it is to read JSON in a
 * terminal. Every figure here came from the request the page just made; an em dash means the
 * record does not carry that thing, which is not the same as zero and not the same as false.
 *
 * The states are inherited from the replay page's discipline, because they answer the same
 * question a reader has when an answer is missing: is the trial not there, is this deployment not
 * checking, or did the thing being checked not answer? A page that renders all three as an empty
 * table teaches a visitor that the system is quiet when it is actually blind.
 *
 * What this page does **not** do, and says so where it is visible: it does not re-run the suite.
 * The artifact's own claim about how many tests passed is quoted from the bytes and labelled as a
 * claim. Verification in the strong sense — executing the pinned suite in an isolated bench — is
 * Argus's job inside a committee, and a public page cannot and should not pretend to be that.
 */

type Phase =
  | { kind: "reading" }
  | { kind: "unreachable" }
  | { kind: "refused"; status: number }
  | { kind: "unreadable" }
  | { kind: "ready"; data: Reproduction };
export default function TrialReproducePage() {
  const params = useParams<{ id: string }>();
  const id = params?.id ?? "";
  const [phase, setPhase] = useState<Phase>({ kind: "reading" });

  useEffect(() => {
    let alive = true;
    const controller = new AbortController();
    setPhase({ kind: "reading" });

    void (async () => {
      let res: Response;
      try {
        res = await fetch(`${API_BASE}/reproduce/${id}`, { signal: controller.signal });
      } catch {
        // A request that died is a different fact from a server that answered it badly, and the
        // two need different repairs: one is this browser's network, the other is this deployment.
        if (alive) setPhase({ kind: "unreachable" });
        return;
      }
      if (!res.ok) {
        if (alive) setPhase({ kind: "refused", status: res.status });
        return;
      }
      let body: unknown;
      try {
        body = await res.json();
      } catch {
        if (alive) setPhase({ kind: "unreadable" });
        return;
      }
      const parsed = asReproduction(body);
      if (alive) {
        if (parsed === null) setPhase({ kind: "unreadable" });
        else setPhase({ kind: "ready", data: parsed });
      }
    })();

    return () => {
      alive = false;
      controller.abort();
    };
  }, [id]);

  if (phase.kind === "reading") {
    return (
      <Chrome>
        <Header id={id} />
        <Quenching label="re-reading the bytes, the signature and the report — not from our index…" />
        <div className="stack" aria-hidden="true">
          {[0, 1, 2, 3, 4].map((i) => (
            <div key={i} className="row">
              <span className="skeleton assay-skel assay-skel--key" />
              <span className="skeleton assay-skel" />
              <span className="skeleton assay-skel" />
            </div>
          ))}
        </div>
      </Chrome>
    );
  }

  if (phase.kind === "unreachable") {
    return (
      <Chrome>
        <Header id={id} />
        <SignalLost message="Nothing answered at the reader. This trial is on the chain — the check did not reach the machine that would run it." />
        <BackLink id={id} />
      </Chrome>
    );
  }

  if (phase.kind === "refused") {
    return (
      <Chrome>
        <Header id={id} />
        {phase.status === 400 ? (
          <div className="surface void-panel">
            <h2 className="void-panel__title" data-tone="sear">
              Not a trial number.
            </h2>
            <p className="void-panel__body">
              A reproduction asks for one trial, and this address did not carry a number the reader
              can use.
            </p>
          </div>
        ) : null}
        {phase.status === 404 ? (
          <div className="surface void-panel">
            <h2 className="void-panel__title" data-tone="sear">
              Nothing was submitted for that trial.
            </h2>
            <p className="void-panel__body">
              The chain holds the trial but no run hash, so there are no bytes, no signature and no
              report to reproduce. That is a trial waiting for work, not a failed one.
            </p>
          </div>
        ) : null}
        {phase.status === 502 ? (
          <SignalLost message="The chain did not answer the reader. Nothing you did broke this — a reproduction that cannot ask the node is not a reproduction." />
        ) : null}
        {phase.status === 503 ? (
          <ColdForge
            line="This deployment is not holding the published evidence next to the chain, so there is nothing here to re-derive the run from. The trial itself is real."
            cta="Back to the trial"
            href={`/trials/${id}`}
          />
        ) : null}
        {![400, 404, 502, 503].includes(phase.status) ? (
          <SignalLost
            message={`The reader answered with ${phase.status}, which this page does not know how to show.`}
          />
        ) : null}
        <BackLink id={id} />
      </Chrome>
    );
  }

  if (phase.kind === "unreadable") {
    return (
      <Chrome>
        <Header id={id} />
        <SignalLost message="The reader answered, but with a body this page could not read — so it is showing you nothing rather than guessing at something." />
        <BackLink id={id} />
      </Chrome>
    );
  }

  const { data } = phase;

  return (
    <Chrome>
      <Header id={id} />
      <p className="lede">
        The same checks, run again from the outside: what the bytes hash to, who signed them, what
        the registry says that key belongs to, and what was graded. Nothing on this page is read
        from our index.
      </p>

      <div className="surface verdict-panel" data-tone={toneFor(data.reproduced)} role="status">
        <p className="verdict-panel__label">
          {data.reproduced
            ? "This run reproduces."
            : "This run does not reproduce — at the bindings named below."}
        </p>
        <p className="verdict-panel__why">
          {data.reproduced
            ? "Every binding checked out against the chain and the published bytes. It still does not mean the suite was re-run here — see the note under the list."
            : "A failed binding is a finding about one specific link, not a verdict on the agent."}
        </p>
      </div>

      <ol className="stack">
        {data.steps.map((step) => {
          const copy = copyFor(step.name);
          return (
            <li key={step.name} className="surface detail-panel" data-tone={toneFor(step.passed)}>
              <p className="kicker">
                {step.passed ? "holds" : "does not hold"} · {copy.title}
              </p>
              {copy.asking ? <p className="hint">{copy.asking}</p> : null}
              {step.failure ? (
                <p className="hint" data-tone="sear">
                  {step.failure}
                </p>
              ) : null}
              <div className="row">
                {detailEntries(step.detail).map(([label, value, key]) => (
                  <span key={key} className="cell">
                    <span className="kicker">{label}</span>
                    <code>{value}</code>
                  </span>
                ))}
              </div>
            </li>
          );
        })}
      </ol>

      <p className="hint hint--block">
        What this page does not do: it does not execute the test suite. Re-running the pinned suite
        in an isolated bench is the verifier&apos;s job inside a committee, and a public page that
        claimed to have done it would be a worse lie than the one it replaces. The counts shown as
        &quot;claimed&quot; come from the artifact&apos;s own bytes and are labelled as its claim,
        not as a measurement taken here.
      </p>

      <BackLink id={id} />
    </Chrome>
  );
}

function Header({ id }: { id: string }) {
  return (
    <>
      <p className="kicker">Trial {id}</p>
      <h1 className="page-title">Reproducing the run</h1>
    </>
  );
}

function BackLink({ id }: { id: string }) {
  return (
    <p className="row">
      <Link className="btn btn-ghost btn-sm" href={`/trials/${id}`}>
        Back to the trial
      </Link>
    </p>
  );
}

