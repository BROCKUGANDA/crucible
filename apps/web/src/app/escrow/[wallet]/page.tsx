"use client";

import Link from "next/link";
import { use, useEffect, useState } from "react";
import { Chrome, ColdForge, Quenching, SignalLost } from "@/components/Chrome";
import { columnsOf, rowsOf, settledNote, type EscrowJson } from "@/lib/escrow/view";
import { API_BASE } from "@/lib/apiBase";
import { shortHash } from "@/lib/forge";

/**
 * Where one address's ETH is inside the escrow (gate 838).
 *
 * The landing page answers what the protocol earned. This answers the other question — the one a
 * sponsor has after refreshing — and answers it in the three states the contract keeps, because
 * they have three different exits: a lock a verdict or a deadline releases, a stake that
 * `unstake` releases, and a claim that `withdraw` pays. Added together they would read as one
 * number the wallet cannot move.
 *
 * Nothing here moves money. Every release named on this page is a call the reader makes from
 * their own wallet — settlement credits a ledger and never sends (ADR-0003).
 */

type Phase =
  | { kind: "reading" }
  | { kind: "unreachable" }
  | { kind: "refused"; status: number }
  | { kind: "ready"; escrow: EscrowJson };

export default function EscrowPage({ params }: { params: Promise<{ wallet: string }> }) {
  const { wallet: rawWallet } = use(params);
  const wallet = rawWallet.toLowerCase();
  const [phase, setPhase] = useState<Phase>({ kind: "reading" });

  useEffect(() => {
    let alive = true;
    const controller = new AbortController();
    setPhase({ kind: "reading" });

    void (async () => {
      try {
        const res = await fetch(`${API_BASE}/escrow/${wallet}`, { signal: controller.signal });
        if (!alive) return;
        if (!res.ok) {
          setPhase({ kind: "refused", status: res.status });
          return;
        }
        setPhase({ kind: "ready", escrow: (await res.json()) as EscrowJson });
      } catch {
        if (alive && !controller.signal.aborted) setPhase({ kind: "unreachable" });
      }
    })();

    return () => {
      alive = false;
      controller.abort();
    };
  }, [wallet]);

  if (phase.kind === "reading") {
    return (
      <Chrome>
        <Quenching label={`reading what the escrow holds for ${shortHash(wallet)}…`} />
      </Chrome>
    );
  }

  if (phase.kind === "unreachable") {
    return (
      <Chrome>
        <SignalLost message="The escrow could not be read. Nothing was lost — this page could not reach the service that reads it." />
      </Chrome>
    );
  }

  if (phase.kind === "refused") {
    return (
      <Chrome>
        <ColdForge
          line={`The escrow answered ${phase.status}. An address is 0x followed by 40 characters.`}
          cta="Try another address"
          href="/escrow"
        />
      </Chrome>
    );
  }

  const escrow = phase.escrow;
  const rows = rowsOf(escrow);

  return (
    <Chrome>
      <p className="kicker">Where this address&apos;s metal is</p>
      <h1 className="page-title">The escrow, by address</h1>
      <p className="hint hint--block">
        Held by <span className="mono">{escrow.escrowAddress ?? "an address this host did not read"}</span> for{" "}
        <span className="mono">{wallet}</span>. Three books, three ways out — and none of them is
        a transfer the protocol makes for you.
      </p>

      <section className="surface detail-panel" aria-label="The three books">
        <ul className="clock-list">
          {columnsOf(escrow).map((c) => (
            <li className="clock-line" key={c.label}>
              <span className="clock-line__label">{c.label}</span>
              <span className="mono clock-line__value" data-tone={c.value === "—" ? "faint" : "gold"}>
                {c.value}
              </span>
              <span className="mono clock-line__source">{c.note}</span>
            </li>
          ))}
        </ul>
      </section>

      <section className="surface detail-panel" aria-label="Locked in live trials">
        <h2 className="section-title section-title--tight">Locked in a live trial</h2>
        {rows.length === 0 ? (
          <p className="clock-prose">Nothing of yours is locked right now.</p>
        ) : (
          <ul className="clock-list">
            {rows.map((r) => (
              <li className="clock-line" key={`${r.trialId}-${r.what}`}>
                <span className="clock-line__label">
                  <Link href={r.href}>trial #{r.trialId}</Link> — {r.who}
                </span>
                <span className="mono clock-line__value" data-tone="gold">
                  {r.amount}
                </span>
                <span className="mono clock-line__source">
                  {r.what} · {r.release} · {r.timing}
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="surface detail-panel" aria-label="Free stake">
        <h2 className="section-title section-title--tight">Free stake on your agents</h2>
        <p className="clock-prose">
          Collateral, not tied to a trial. It becomes claimable when you call <span className="mono">unstake</span> on
          the agent, and leaves the contract only when you call <span className="mono">withdraw</span>.
        </p>
        {escrow.stakes.length === 0 ? (
          <p className="clock-prose">No agent is registered to this address.</p>
        ) : (
          <ul className="clock-list">
            {escrow.stakes.map((s) => (
              <li className="clock-line" key={s.agentId}>
                <span className="clock-line__label">
                  <Link href={`/agents/${s.agentId}`}>agent #{s.agentId}</Link>
                </span>
                <span className="mono clock-line__value" data-tone="gold">
                  {s.eth} ETH
                </span>
                <span className="mono clock-line__source">free collateral</span>
              </li>
            ))}
          </ul>
        )}
      </section>

      <p className="clock-prose">
        {settledNote(escrow)}. <Link href="/trials">Browse the trials</Link> or{" "}
        <Link href="/claims">read what the protocol claims</Link>.
      </p>
    </Chrome>
  );
}
