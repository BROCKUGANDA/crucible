"use client";

import Link from "next/link";
import { use, useEffect, useRef } from "react";
import { Chrome, Quenching, SignalLost } from "@/components/Chrome";
import { useSnapshot } from "@/lib/useSnapshot";
import { formatEth, shortHash, statusMeta, tierMeta, verdictMeta } from "@/lib/forge";

const NEXT_TIER = [1, 3, 10, 25] as const;

export default function AgentProfilePage({ params }: { params: Promise<{ id: string }> }) {
  // Next 15 hands route params to client components as a Promise. Reading `params.id`
  // directly type-checks under `tsc --noEmit` and fails `next build`, which validates the
  // generated PageProps — so the unwrap has to be here, not in a cast.
  const { id: rawId } = use(params);
  const id = Number(rawId);
  const { data, error, loading } = useSnapshot();
  const agent = data?.agents.find((a) => a.id === id);
  const trials = data?.trials.filter((t) => t.agentId === id) ?? [];

  // Absent and unknown are different answers. `!agent` alone is true while the first
  // snapshot is still in flight, so a valid agent id painted "Lost slag." for a beat and
  // then resolved — a not-found page that lies.
  if (loading && !data) {
    return (
      <Chrome>
        <Quenching label={`reading agent ${rawId}'s record from the chain…`} />
      </Chrome>
    );
  }

  // A dead index is not a missing agent — the roster cannot know whether id exists
  // until the stream comes back, so say that instead of sentencing the agent to void.
  if (error && !data) {
    return (
      <Chrome>
        <SignalLost message={error} />
      </Chrome>
    );
  }

  if (!agent) {
    return (
      <Chrome>
        <div className="surface void-panel">
          <h2 className="void-panel__title">Agent not found.</h2>
          <p className="void-panel__body">No agent is registered under this id.</p>
          <Link className="btn btn-primary" href="/agents">
            Back to agents
          </Link>
        </div>
      </Chrome>
    );
  }

  const tier = agent.tier === null ? null : tierMeta(agent.tier);
  const target = agent.tier === null ? undefined : NEXT_TIER[agent.tier];
  // An unread tier has no next step to count toward. Show an empty bar and say so, rather
  // than a percentage invented from a tier nobody read.
  const progress =
    agent.tier === null ? 0 : target ? Math.min(100, Math.round((agent.wins / target) * 100)) : 100;

  return (
    <Chrome>
      <p className="kicker">Agent {agent.id}</p>
      <h1 className="page-title agent-title">
        <span className="chip" data-tone={tier?.tone ?? "faint"}>
          {tier?.name ?? "tier unknown"}
        </span>
      </h1>

      <div className="surface alloy-panel">
        <AlloyBar progress={progress} />
        <p className="mono alloy-note">
          {agent.tier === null
            ? "Tier unavailable — the registry was not read."
            : target
              ? `${agent.wins} of ${target} wins to ${tierMeta(agent.tier + 1).name}`
              : "Top tier"}
        </p>
      </div>

      <div className="surface detail-panel">
        <Row label="Operator" value={agent.operator} />
        <Row label="Runner" value={shortHash(agent.runner)} />
        <Row label="Stake" value={formatEth(agent.stakeEth)} />
        <Row label="Wins" value={String(agent.wins)} />
        <Row label="Survived breaks" value={String(agent.survived)} />
        <Row label="Slashes" value={String(agent.slashes)} />
        <Row label="Identity generation" value={agent.epoch === null ? "—" : String(agent.epoch)} />
        {agent.epoch !== null && agent.epoch > 1 ? (
          // ADR-0012. Three books can disagree on this row and all three are true: what this index
          // counted (above), what the current holder earned (the tier), and what the identity ever
          // earned (below). Saying which is which is the whole point of making a reset legible.
          <p className="hint hint--block">
            This identity has changed operator {agent.epoch - 1} {agent.epoch - 1 === 1 ? "time" : "times"}.
            The tier above belongs to the current operator; the wins and slashes above cover every
            generation this index has seen. The record carries{" "}
            {agent.lifetimeWins === null ? "no lifetime win figure it could read" : `${agent.lifetimeWins} lifetime wins`}
            {" and "}
            {agent.lifetimeSlashes === null ? "no lifetime slash figure it could read" : `${agent.lifetimeSlashes} lifetime slashes`}
            , which a handover does not reset.
          </p>
        ) : null}
      </div>

      <h2 className="section-title section-title--detached">Submitted runs</h2>
      {trials.length === 0 ? (
        <p className="lede">No runs submitted yet.</p>
      ) : (
        <div className="run-list">
          {trials.map((t) => {
            // A run that has not settled has no verdict to name — showing the raw enum string
            // ("none") would print a word from the wire protocol. Show the verdict once there is
            // one, and the trial's standing until then.
            const verdict = t.verdict === "none" ? null : verdictMeta(t.verdict);
            const status = statusMeta(t.status);
            const meta = verdict ?? status;
            return (
              <Link key={t.id} href={`/trials/${t.id}`} className="raised run-link">
                <span className="mono">Trial {t.id}</span>
                <span className="mono" data-tone={meta.tone}>
                  {meta.label}
                </span>
              </Link>
            );
          })}
        </div>
      )}

      <h2 className="section-title section-title--detached">Slashes</h2>
      {agent.slashes === 0 ? (
        <p className="lede">No slashes yet.</p>
      ) : (
        <p className="lede" data-tone="sear">
          {agent.slashes} {agent.slashes === 1 ? "run was" : "runs were"} disproven. Each slash
          reduced this agent&rsquo;s earned wins by 25%, and it stays in the lifetime record even
          when the identity changes operator.
        </p>
      )}
    </Chrome>
  );
}

/**
 * The bar's width is data, so it arrives as a custom property written through the CSSOM:
 * the stylesheet owns the drawing (`.alloy-bar__fill`), the component owns the number.
 */
function AlloyBar({ progress }: { progress: number }) {
  const fillRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    fillRef.current?.style.setProperty("--alloy-progress", String(progress));
  }, [progress]);

  return (
    <div className="alloy-bar">
      <div ref={fillRef} className="alloy-bar__fill" />
    </div>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="kv">
      <span className="kv__key">{label}</span>
      <span className="mono">{value}</span>
    </div>
  );
}
