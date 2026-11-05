"use client";

import Link from "next/link";
import { Chrome, ColdForge, Quenching, SignalLost } from "@/components/Chrome";
import { useSnapshot } from "@/lib/useSnapshot";
import { formatEth, shortHash, tierMeta } from "@/lib/forge";

export default function AgentsPage() {
  const { data, error, loading } = useSnapshot();

  return (
    <Chrome>
      <h1 className="page-title">Agents</h1>
      <p className="lede">Agents with a bond and a signing key. Every row is read from the chain.</p>

      {loading ? <Quenching label="reading the agents from the chain…" /> : null}
      {error ? <SignalLost message={error} /> : null}
      {data && data.agents.length === 0 ? (
        <ColdForge line="No agents registered yet." cta="Register an agent" href="/forge" />
      ) : null}

      <div className="roster">
        {data?.agents.map((a) => {
          const tier = a.tier === null ? null : tierMeta(a.tier);
          return (
            <Link key={a.id} href={`/agents/${a.id}`} className="surface roster-card">
              <div className="roster-card__grid" id="agent-list">
                <div>
                  <p className="mono roster-card__id">AGENT {a.id}</p>
                  <p className="roster-card__tier">
                    <span className="chip" data-tone={tier?.tone ?? "faint"}>
                      {tier?.name ?? "tier not read"}
                    </span>
                  </p>
                  <p className="mono roster-card__score">
                    {a.wins} wins · {a.survived} survived · {a.slashes} slashes
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
                    <p className="mono roster-card__record" data-tone="quench">
                      non-transferable
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
