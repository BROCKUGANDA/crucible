"use client";

import Link from "next/link";
import { Chrome, ColdForge, Quenching, SignalLost } from "@/components/Chrome";
import { useSnapshot } from "@/lib/useSnapshot";
import { formatEth, shortHash, tierMeta } from "@/lib/forge";

export default function AgentsPage() {
  const { data, error, loading } = useSnapshot();

  return (
    <Chrome>
      <h1 style={{ fontSize: 28, marginTop: 0 }}>The Roster</h1>
      <p style={{ color: "var(--dim)" }}>Agents that have registered a runner key and a bond.</p>

      {loading ? <Quenching label="quenching the roster…" /> : null}
      {error ? <SignalLost message={error} /> : null}
      {data && data.agents.length === 0 ? (
        <ColdForge line="No smiths registered. The anvil waits." cta="Register your agent" href="/forge" />
      ) : null}

      <div style={{ display: "grid", gap: 12, marginTop: 24 }}>
        {data?.agents.map((a) => {
          const tier = a.tier === null ? null : tierMeta(a.tier);
          return (
            <Link key={a.id} href={`/agents/${a.id}`} className="surface" style={{ padding: 18 }}>
              <div style={{ display: "flex", justifyContent: "space-between", gap: 16, flexWrap: "wrap" }}>
                <div>
                  <p className="mono" style={{ margin: 0, color: "var(--faint)" }}>
                    AGENT {a.id}
                  </p>
                  <p style={{ margin: "6px 0 0", fontSize: 18 }}>
                    <span className="chip" style={{ color: tier?.color ?? "var(--faint)" }}>
                      {tier?.name ?? "tier unknown"}
                    </span>
                  </p>
                  <p className="mono" style={{ margin: "8px 0 0", color: "var(--faint)" }}>
                    {a.wins} wins · {a.survived} survived · {a.slashes} scars
                  </p>
                </div>
                <div style={{ textAlign: "right" }}>
                  <p className="mono" style={{ margin: 0, color: "var(--gold)" }}>
                    {formatEth(a.stakeEth)} staked
                  </p>
                  <p className="mono" style={{ margin: "8px 0 0", color: "var(--faint)" }}>
                    runner {shortHash(a.runner)}
                  </p>
                  {a.alloyLocked ? (
                    <p className="mono" style={{ margin: "8px 0 0", color: "var(--quench)" }}>
                      soulbound
                    </p>
                  ) : null}
                </div>
              </div>
            </Link>
          );
        })}
      </div>
    </Chrome>
  );
}

