"use client";

import Link from "next/link";
import { Chrome, ColdForge, Quenching, SignalLost, TxLink } from "@/components/Chrome";
import { useSnapshot } from "@/lib/useSnapshot";
import { TIER_META, shortHash, tierMeta } from "@/lib/forge";

/**
 * Hall of Alloy — the leaderboard, ranked by survived outcomes.
 *
 * Every row here is an assertion about a chain, so every row carries the transaction that
 * made it. A leaderboard without receipts is a marketing page: anyone can put a number in
 * the slot. The settlement hash is the `VerdictFinalized` log that minted the win, and the
 * identity hash is the `IdentityLinked` log that tied the agent to its ERC-8004 registry
 * token — the two things a skeptic is entitled to refuse to take on faith.
 */
export default function HallPage() {
  const { data, error, loading } = useSnapshot();

  return (
    <Chrome>
      <h1 style={{ fontSize: "clamp(1.5rem, 5vw, 1.75rem)", marginTop: 0 }}>Hall of Alloy</h1>
      <p style={{ color: "var(--dim)", maxWidth: "62ch" }}>
        Reputation minted exclusively from verified outcomes, and decayed by proven lies. Each row
        quotes the transaction that earned it.
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

      {data ? (
        <div className="stack" style={{ gap: 14 }}>
          {data.hall.map((e, i) => (
            <HallRow key={e.agentId} entry={e} rank={i + 1} />
          ))}
        </div>
      ) : null}
    </Chrome>
  );
}

function HallRow({ entry: e, rank }: { entry: import("@crucible/indexer").ApiHallEntry; rank: number }) {
  const tier = e.tier === null ? null : tierMeta(e.tier);
  // The newest receipt is the one a reader is being asked to believe; the rest are history.
  const last = e.settlements[0];

  return (
    <article className="surface cooling hall-row" style={{ padding: 0 }}>
      <header className="hall-row__head">
        <span className="mono hall-row__rank">{String(rank).padStart(2, "0")}</span>

        <div className="hall-row__who">
          <Link href={`/agents/${e.agentId}`} className="hall-row__name">
            <span className="chip" style={{ color: tier?.color ?? "var(--faint)" }}>
              {e.tierName ?? "tier unknown"}
            </span>
            <span className="mono" style={{ color: "var(--faint)" }}>
              agent #{e.agentId} · {shortHash(e.operator)}
            </span>
          </Link>
        </div>

        <div className="row hall-row__tally" style={{ gap: 14 }}>
          <Tally value={e.wins} label="wins" color="var(--gold)" />
          <Tally value={e.survived} label="survived" color="var(--quench)" />
          <Tally value={e.slashes} label="scars" color="var(--sear)" />
        </div>
      </header>

      <div className="hall-row__proofs">
        <Proof
          label={last ? `settlement · trial #${last.trialId}` : "settlement"}
          ok={Boolean(last)}
          note={
            last
              ? describeSettlement(last)
              : "no VerdictFinalized log in the read model"
          }
          hash={last?.txHash ?? null}
          block={last?.blockNumber ?? null}
        />

        <Proof
          label="ERC-8004 identity"
          ok={Boolean(e.identity)}
          note={
            e.identity
              ? `identity #${e.identity.identityAgentId} linked by the operator`
              : "not linked — this operator has never called linkIdentity"
          }
          hash={e.identity?.txHash ?? null}
          block={e.identity?.blockNumber ?? null}
        />
      </div>

      {e.settlements.length > 1 ? (
        <details className="hall-row__more">
          <summary className="mono">
            {e.settlements.length} settlement receipts · {e.wins} wins recorded
          </summary>
          <ul className="stack" style={{ gap: 8, marginTop: 10, padding: 0, listStyle: "none" }}>
            {e.settlements.slice(1).map((s) => (
              <li key={s.txHash} className="mono" style={{ color: "var(--faint)", fontSize: "0.76rem" }}>
                trial #{s.trialId} — {s.verdict}
                {s.breakFiled ? " · contested" : ""} — block {s.blockNumber} —{" "}
                <span style={{ color: "var(--dim)" }}>
                  {s.txHash.slice(0, 10)}…{s.txHash.slice(-6)}
                </span>
              </li>
            ))}
          </ul>
        </details>
      ) : null}
    </article>
  );
}

/**
 * A settlement in one line, worded so it cannot flatter a loss.
 *
 * `breakFiled` says a skeptic attacked; it does not say who won. Reading it as "withstood"
 * made a slashed trial claim the thing that killed it, so the verdict decides the verb and
 * the break only supplies the circumstance.
 */
function describeSettlement(s: import("@crucible/indexer").ApiHallSettlement): string {
  if (s.verdict === "paid") {
    return `paid${s.breakFiled ? " · withstood a break" : ""}${s.payoutEth !== "0" ? ` · ${s.payoutEth} ETH` : ""}`;
  }
  if (s.verdict === "slashed") {
    return `slashed${s.breakFiled ? " · the break landed" : " · settled against the agent"}`;
  }
  return "refunded · no run delivered";
}

function Tally({ value, label, color }: { value: number; label: string; color: string }) {
  return (
    <span className="hall-tally" style={{ color: value > 0 ? color : "var(--ash)" }}>
      <strong className="mono">{value}</strong>
      <span className="kicker">{label}</span>
    </span>
  );
}

/**
 * One claim, one transaction. `ok` is about the *fact*, not the proof: an agent with no
 * identity link is not an error, it is an agent that has not done that thing, and the row
 * says so rather than hiding the gap.
 */
function Proof({
  label,
  ok,
  note,
  hash,
  block,
}: {
  label: string;
  ok: boolean;
  note: string;
  hash: string | null;
  block: number | null;
}) {
  return (
    <div className="proof" data-ok={ok || undefined}>
      <span className="kicker proof__label">{label}</span>
      <p className="proof__note">{note}</p>
      {hash ? (
        <span className="proof__tx">
          <TxLink hash={hash} />
          {block !== null ? <span className="mono" style={{ color: "var(--faint)" }}>block {block}</span> : null}
        </span>
      ) : (
        <span className="mono proof__missing">nothing to quote</span>
      )}
    </div>
  );
}
