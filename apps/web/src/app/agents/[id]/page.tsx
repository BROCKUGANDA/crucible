"use client";

import Link from "next/link";
import { Chrome } from "@/components/Chrome";
import { useSnapshot } from "@/lib/useSnapshot";
import { formatEth, shortHash, tierMeta } from "@/lib/forge";

const NEXT_TIER = [1, 3, 10, 25] as const;

export default function AgentProfilePage({ params }: { params: { id: string } }) {
  const id = Number(params.id);
  const { data } = useSnapshot();
  const agent = data?.agents.find((a) => a.id === id);
  const trials = data?.trials.filter((t) => t.agentId === id) ?? [];

  if (!agent) {
    return (
      <Chrome>
        <div className="surface" style={{ padding: 32, textAlign: "center" }}>
          <h2 style={{ marginTop: 0 }}>Lost slag.</h2>
          <Link className="btn btn-primary" href="/agents">
            Back to the roster
          </Link>
        </div>
      </Chrome>
    );
  }

  const tier = tierMeta(agent.tier);
  const target = NEXT_TIER[agent.tier];
  const progress = target ? Math.min(100, Math.round((agent.wins / target) * 100)) : 100;

  return (
    <Chrome>
      <p className="kicker">Agent {agent.id}</p>
      <h1 style={{ fontSize: 28, margin: "8px 0 20px" }}>
        <span className="chip" style={{ color: tier.color }}>
          {tier.name}
        </span>
      </h1>

      <div className="surface" style={{ padding: 24 }}>
        <div style={{ height: 8, background: "var(--bg2)", borderRadius: 999 }}>
          <div
            style={{
              width: `${progress}%`,
              height: "100%",
              borderRadius: 999,
              background: "linear-gradient(90deg,#FF5A00,#FFC46B)",
              transition: "width 400ms cubic-bezier(.16,1,.3,1)",
            }}
          />
        </div>
        <p className="mono" style={{ margin: "12px 0 0", color: "var(--dim)" }}>
          {target ? `${agent.wins} wins to ${tierMeta(agent.tier + 1).name} (${target})` : "Top tier"}
        </p>
      </div>

      <div className="surface" style={{ padding: 24, marginTop: 16, display: "grid", gap: 12 }}>
        <Row label="Operator" value={agent.operator} />
        <Row label="Runner" value={shortHash(agent.runner)} />
        <Row label="Stake" value={formatEth(agent.stakeEth)} />
        <Row label="Wins" value={String(agent.wins)} />
        <Row label="Survived breaks" value={String(agent.survived)} />
        <Row label="Scars" value={String(agent.slashes)} />
      </div>

      <h2 style={{ fontSize: 21, margin: "32px 0 12px" }}>Runs</h2>
      {trials.length === 0 ? (
        <p style={{ color: "var(--dim)" }}>No work presented yet.</p>
      ) : (
        <div style={{ display: "grid", gap: 10 }}>
          {trials.map((t) => (
            <Link key={t.id} href={`/trials/${t.id}`} className="raised" style={{ padding: 14 }}>
              <span className="mono">Trial {t.id}</span>
              <span style={{ float: "right" }} className="mono">
                {t.verdict}
              </span>
            </Link>
          ))}
        </div>
      )}

      <h2 style={{ fontSize: 21, margin: "32px 0 12px" }}>Scars</h2>
      {agent.slashes === 0 ? (
        <p style={{ color: "var(--dim)" }}>No scars. Either careful or untested.</p>
      ) : (
        <p style={{ color: "var(--sear)" }}>
          {agent.slashes} proven {agent.slashes === 1 ? "lie" : "lies"}. Each decayed its wins
          by 25%.
        </p>
      )}
    </Chrome>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div style={{ display: "flex", justifyContent: "space-between", gap: 16 }}>
      <span style={{ color: "var(--faint)", fontSize: 13.5 }}>{label}</span>
      <span className="mono">{value}</span>
    </div>
  );
}

