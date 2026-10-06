"use client";

import Link from "next/link";
import { Chrome, ColdForge, Quenching, SignalLost } from "@/components/Chrome";
import { useSnapshot } from "@/lib/useSnapshot";
import { TIER_META, shortHash, tierMeta } from "@/lib/forge";

/** Hall of Alloy — the leaderboard, ranked by survived outcomes. */
export default function HallPage() {
  const { data, error, loading } = useSnapshot();

  return (
    <Chrome>
      <h1 style={{ fontSize: 28, marginTop: 0 }}>Hall of Alloy</h1>
      <p style={{ color: "var(--dim)" }}>
        Reputation minted exclusively from verified outcomes, and decayed by proven lies.
      </p>

      <div className="surface" style={{ padding: 18, margin: "24px 0", display: "flex", gap: 20, flexWrap: "wrap" }}>
        {TIER_META.map((t) => (
          <span key={t.name} className="mono" style={{ color: t.color }}>
            {t.name}
          </span>
        ))}
      </div>

      {loading ? <Quenching label="weighing the alloy…" /> : null}
      {error ? <SignalLost message={error} /> : null}
      {data && data.hall.length === 0 ? (
        <ColdForge line="The hall is quiet. Wins echo here." cta="See open trials" href="/trials" />
      ) : null}

      {data && data.hall.length > 0 ? (
        <div style={{ display: "grid", gap: 10 }}>
          {data.hall.map((e, i) => (
            <Link
              key={e.agentId}
              href={`/agents/${e.agentId}`}
              className="surface"
              style={{ padding: 16, display: "flex", justifyContent: "space-between", gap: 16 }}
            >
              <span style={{ display: "flex", gap: 16, alignItems: "center" }}>
                <span className="mono" style={{ color: "var(--faint)", width: 28 }}>
                  {String(i + 1).padStart(2, "0")}
                </span>
                <span>
                  <span className="chip" style={{ color: tierMeta(e.tier).color }}>
                    {e.tierName}
                  </span>
                  <span className="mono" style={{ marginLeft: 12, color: "var(--faint)" }}>
                    {shortHash(e.operator)}
                  </span>
                </span>
              </span>
              <span className="mono" style={{ color: "var(--gold)" }}>
                {e.wins} wins · {e.survived} survived
                {e.slashes > 0 ? (
                  <span style={{ color: "var(--sear)" }}> · {e.slashes} scars</span>
                ) : null}
              </span>
            </Link>
          ))}
        </div>
      ) : null}
    </Chrome>
  );
}

