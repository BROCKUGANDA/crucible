"use client";

import Link from "next/link";
import { use, useEffect, useRef } from "react";
import { Chrome, Quenching, SignalLost } from "@/components/Chrome";
import { useSnapshot } from "@/lib/useSnapshot";
import { formatEth, shortHash, tierMeta } from "@/lib/forge";

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
        <Quenching label={`drawing agent ${rawId} from the fire…`} />
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
          <h2 className="void-panel__title">Lost slag.</h2>
          <Link className="btn btn-primary" href="/agents">
            Back to the roster
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
            ? "the alloy registry was not read — no tier to show"
            : target
              ? `${agent.wins} wins to ${tierMeta(agent.tier + 1).name} (${target})`
              : "Top tier"}
        </p>
      </div>

      <div className="surface detail-panel">
        <Row label="Operator" value={agent.operator} />
        <Row label="Runner" value={shortHash(agent.runner)} />
        <Row label="Stake" value={formatEth(agent.stakeEth)} />
        <Row label="Wins" value={String(agent.wins)} />
        <Row label="Survived breaks" value={String(agent.survived)} />
        <Row label="Scars" value={String(agent.slashes)} />
      </div>

      <h2 className="section-title section-title--detached">Runs</h2>
      {trials.length === 0 ? (
        <p className="lede">No work presented yet.</p>
      ) : (
        <div className="run-list">
          {trials.map((t) => (
            <Link key={t.id} href={`/trials/${t.id}`} className="raised run-link">
              <span className="mono">Trial {t.id}</span>
              <span className="mono">{t.verdict}</span>
            </Link>
          ))}
        </div>
      )}

      <h2 className="section-title section-title--detached">Scars</h2>
      {agent.slashes === 0 ? (
        <p className="lede">No scars. Either careful or untested.</p>
      ) : (
        <p className="lede" data-tone="sear">
          {agent.slashes} proven {agent.slashes === 1 ? "lie" : "lies"}. Each decayed its wins
          by 25%.
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
