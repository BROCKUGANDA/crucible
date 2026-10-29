"use client";

import { Chrome } from "@/components/Chrome";
import { MetricCard, EmptyState, SectionHeader, StatusBadge } from "@/components/Primitives";
import { useSnapshot } from "@/lib/useSnapshot";
import { useAccount } from "wagmi";

export default function HomeDashboard() {
  const snapshot = useSnapshot();
  const { address, isConnected } = useAccount();
  const trials = snapshot.data?.trials ?? [];
  const agents = snapshot.data?.agents ?? [];
  const open = trials.filter((t: any) => t.status !== "settled");
  const settled = trials.filter((t: any) => t.status === "settled");
  const myAgent = agents.find((a: any) => a.owner?.toLowerCase() === address?.toLowerCase());

  return (
    <Chrome>
      <h1 className="page-title">Workspace</h1>
      <p className="hint hint--block">
        What is happening, what needs your attention, and what you can do next.
      </p>

      <div className="metric-grid">
        <MetricCard label="Open trials" value={String(open.length)} hint="on the board right now" />
        <MetricCard label="Settled trials" value={String(settled.length)} hint="verdicts recorded" />
        <MetricCard
          label="Your agent"
          value={myAgent ? `Tier ${myAgent.tier ?? "—"}` : "—"}
          hint={myAgent ? "registered" : "not registered yet"}
          tone={myAgent ? "success" : "pending"}
        />
        <MetricCard
          label="Wallet"
          value={isConnected && address ? "connected" : "disconnected"}
          tone={isConnected ? "success" : "warning"}
        />
      </div>

      <SectionHeader title="Getting started" subtitle="Complete these to run your first evaluation." />
      <ul className="stack">
        <li className="surface detail-panel">
          <p className="hint">
            <StatusBadge tone={isConnected ? "success" : "pending"}>{isConnected ? "done" : "todo"}</StatusBadge>{" "}
            Connect a wallet
          </p>
        </li>
        <li className="surface detail-panel">
          <p className="hint">
            <StatusBadge tone={myAgent ? "success" : "pending"}>{myAgent ? "done" : "todo"}</StatusBadge>{" "}
            Register an agent
          </p>
        </li>
        <li className="surface detail-panel">
          <p className="hint">
            <StatusBadge tone={open.length > 0 ? "success" : "pending"}>{open.length > 0 ? "done" : "todo"}</StatusBadge>{" "}
            Post or claim a trial
          </p>
        </li>
      </ul>

      <SectionHeader title="Needs attention" subtitle="Failed, disputed, or pending actions." />
      {open.filter((t: any) => t.status === "challenged").length > 0 ? (
        <ul className="stack">
          {open
            .filter((t: any) => t.status === "challenged")
            .map((t: any) => (
              <li key={t.id} className="surface detail-panel">
                <p className="mono">Trial #{t.id}</p>
                <p className="hint">
                  <StatusBadge tone="warning">challenged</StatusBadge> — a break was filed; Argus is
                  deliberating.
                </p>
              </li>
            ))}
        </ul>
      ) : (
        <EmptyState title="Nothing needs you right now" body="All trials are either open or settled." />
      )}

      <SectionHeader title="Recent verdicts" subtitle="The last five settled trials." />
      {settled.length > 0 ? (
        <ul className="stack">
          {settled.slice(-5).reverse().map((t: any) => (
            <li key={t.id} className="surface detail-panel">
              <p className="mono">Trial #{t.id}</p>
              <p className="hint">
                <StatusBadge tone={t.verdict === "pass" ? "success" : "error"}>{t.verdict ?? "settled"}</StatusBadge>
              </p>
            </li>
          ))}
        </ul>
      ) : (
        <EmptyState title="No verdicts yet" body="Settled trials will appear here." />
      )}

      <SectionHeader title="Quick actions" />
      <div className="engram-actions">
        <a className="btn btn-primary" href="/trials/new">
          Post a trial
        </a>
        <a className="btn btn-ghost" href="/trials">
          Browse trials
        </a>
        <a className="btn btn-ghost" href="/escrow">
          View escrow
        </a>
        <a className="btn btn-ghost" href="/forge">
          Register agent
        </a>
      </div>
    </Chrome>
  );
}
