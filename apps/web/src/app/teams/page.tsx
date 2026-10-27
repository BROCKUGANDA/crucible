"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { Chrome, ColdForge, Quenching, SignalLost } from "@/components/Chrome";
import { API_BASE } from "@/lib/apiBase";
import { moneyLinesOf, stageRowsOf, teamsView, type TeamsPayload } from "@/lib/teams/view";

/**
 * The team ledger, published (gate 879).
 *
 * Who did which stage of a team's work, and what they agreed to be paid — the attribution the
 * escrow deliberately does not carry, because one trial has one claimant. Every stage hash here is
 * a digest a reader can fetch and re-hash; every share was signed by the member it names, which is
 * the one thing a lead cannot do on someone's behalf.
 *
 * `projected: false` is rendered as its own state. A host with no TeamLedger address has not
 * counted zero teams, and an empty list would say it did.
 */

type Phase =
  | { kind: "reading" }
  | { kind: "unreachable" }
  | { kind: "refused"; status: number }
  | { kind: "ready"; payload: TeamsPayload };

export default function TeamsPage() {
  const [phase, setPhase] = useState<Phase>({ kind: "reading" });

  useEffect(() => {
    let alive = true;
    const controller = new AbortController();
    void (async () => {
      try {
        const res = await fetch(`${API_BASE}/teams`, { signal: controller.signal });
        if (!alive) return;
        if (!res.ok) {
          setPhase({ kind: "refused", status: res.status });
          return;
        }
        setPhase({ kind: "ready", payload: (await res.json()) as TeamsPayload });
      } catch {
        if (alive && !controller.signal.aborted) setPhase({ kind: "unreachable" });
      }
    })();
    return () => {
      alive = false;
      controller.abort();
    };
  }, []);

  if (phase.kind === "reading") {
    return (
      <Chrome>
        <Quenching label="reading the team ledger from the chain…" />
      </Chrome>
    );
  }
  if (phase.kind === "unreachable") {
    return (
      <Chrome>
        <SignalLost message="The team ledger could not be read. Nothing was lost — this page could not reach the service that reads it." />
      </Chrome>
    );
  }
  if (phase.kind === "refused") {
    return (
      <Chrome>
        <ColdForge
          line={`The ledger answered ${phase.status}, so there is nothing to show rather than an empty answer to trust.`}
          cta="Back to the trials"
          href="/trials"
        />
      </Chrome>
    );
  }

  const view = teamsView(phase.payload);

  if (view.state === "unprojected") {
    return (
      <Chrome>
        <p className="kicker">Attribution beside the escrow</p>
        <h1 className="page-title">Teams</h1>
        <p className="hint hint--block">
          This host is not indexing a team ledger — {view.reason}. That is a fact about the
          deployment, not a count of teams: the zero is not measured.
        </p>
        <p className="clock-prose">
          The escrow itself still has one claimant per trial, one bond and one 5% fee. This ledger
          only records who in a team did which stage. <Link href="/clock">How a trial settles</Link>.
        </p>
      </Chrome>
    );
  }

  return (
    <Chrome>
      <p className="kicker">Attribution beside the escrow</p>
      <h1 className="page-title">Teams</h1>
      <p className="hint hint--block">
        {view.rows.length === 0 ? (
          <>This host indexes a team ledger and it holds no teams yet.</>
        ) : (
          <>
            {view.rows.length} {view.rows.length === 1 ? "team" : "teams"} on the chain. Credited
            total {view.totalCreditEth}, still held {view.heldTotalEth}. A credit is not a payment —
            the member withdraws it from their own wallet.
          </>
        )}
      </p>

      {view.rows.map((team) => (
        <section className="surface detail-panel" key={team.teamKey} aria-label={`team ${team.teamKey.slice(0, 10)}`}>
          <h2 className="section-title section-title--tight">
            Team <span className="mono">{team.teamKey.slice(0, 18)}…</span>
          </h2>
          <p className="clock-prose">
            {team.memberCount} members, led by <span className="mono">{team.lead}</span>, with{" "}
            {team.stageCount} {team.stageCount === 1 ? "stage" : "stages"} attested by the member who
            did them.
          </p>
          <ul className="clock-list">
            {moneyLinesOf(team).map((line) => (
              <li className="clock-line" key={line.label}>
                <span className="clock-line__label">{line.label}</span>
                <span className="mono clock-line__value" data-tone={line.value === "—" ? "faint" : "gold"}>
                  {line.value}
                </span>
              </li>
            ))}
          </ul>
          {team.stages.length > 0 && (
            <ul className="clock-list">
              {stageRowsOf(team).map((s) => (
                <li className="clock-line" key={s.hash}>
                  <span className="clock-line__label">{s.label}</span>
                  <span className="mono clock-line__value">{s.member}</span>
                  <span className="mono clock-line__source">
                    {s.hash.slice(0, 18)}… at block {s.block}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </section>
      ))}

      <p className="clock-prose">
        The trial the stages name is on the board: <Link href="/trials">trials</Link>, and each
        trial&apos;s pinned suite can be read from its own page.{" "}
        <Link href="/escrow">Where an address&apos;s ETH sits</Link>.
      </p>
    </Chrome>
  );
}
