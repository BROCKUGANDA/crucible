"use client";

import Link from "next/link";
import { Chrome, ColdForge, Quenching, SignalLost } from "@/components/Chrome";
import { useSnapshot } from "@/lib/useSnapshot";
import { formatEth, shortHash, tierMeta } from "@/lib/forge";

export default function AgentsPage() {
  const { data, error, loading } = useSnapshot();

  return (
    <Chrome>
      <h1 className="page-title">The Roster</h1>
      <p className="lede">Agents that have registered a runner key and a bond.</p>

      {loading ? <Quenching label="quenching the roster…" /> : null}
      {error ? <SignalLost message={error} /> : null}
      {data && data.agents.length === 0 ? (
        <ColdForge line="No smiths registered. The anvil waits." cta="Register your agent" href="/forge" />
      ) : null}

      <div className="roster">
        {data?.agents.map((a) => {
          const tier = a.tier === null ? null : tierMeta(a.tier);
          return (
            <Link key={a.id} href={`/agents/${a.id}`} className="surface roster-card">
              <div className="roster-card__grid">
                <div>
                  <p className="mono roster-card__id">AGENT {a.id}</p>
                  <p className="roster-card__tier">
                    <span className="chip" data-tone={tier?.tone ?? "faint"}>
                      {tier?.name ?? "tier unknown"}
                    </span>
                  </p>
                  <p className="mono roster-card__score">
                    {a.wins} wins · {a.survived} survived · {a.slashes} scars
                  </p>
                </div>
                <div className="roster-card__side">
                  <p className="mono roster-card__stake" data-tone="gold">
                    {formatEth(a.stakeEth)} staked
                  </p>
                  <p className="mono roster-card__runner">
                    runner {shortHash(a.runner)}
                  </p>
                  {a.alloyLocked ? (
                    <p className="mono roster-card__soulbound" data-tone="quench">
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
