"use client";

import Link from "next/link";
import { Chrome } from "@/components/Chrome";
import { MetricCard, EmptyState, SectionHeader, StatusBadge } from "@/components/Primitives";
import { useSnapshot } from "@/lib/useSnapshot";
import { useAccount } from "wagmi";
import { agentCard } from "@/lib/workspace-cards";
import { verdictMeta } from "@/lib/forge";



export default function HomeDashboard() {
  const snapshot = useSnapshot();
  const { address, isConnected } = useAccount();
  const trials = snapshot.data?.trials ?? [];
  const agents = snapshot.data?.agents ?? [];
  const open = trials.filter((t: any) => t.status !== "settled");
  const settled = trials.filter((t: any) => t.status === "settled");
  // The indexer names the agent's wallet `operator`; reading `owner` here made the match
  // impossible, so "Your agent" read as unregistered for every wallet.
  const myAgent = agents.find((a: any) => a.operator?.toLowerCase() === address?.toLowerCase());
  // The card asks a question about a wallet, so it must know whether one was read: an address
  // left in wagmi's storage while the connection is gone is not a read wallet.
  const myAgentCard = agentCard({
    walletRead: isConnected && Boolean(address),
    tier: myAgent?.tier,
    hasAgent: Boolean(myAgent),
  });

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
          value={myAgentCard.value}
          hint={myAgentCard.hint}
          tone={myAgentCard.tone}
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
          {!isConnected && (
            <>
              <p className="hint">Your wallet is disconnected — connect it to open the forge and sign trials.</p>
              <Link className="btn btn-primary" href="/forge">
                Open the forge
              </Link>
            </>
          )}
        </li>
        <li className="surface detail-panel">
          <p className="hint">
            <StatusBadge tone={myAgent ? "success" : "pending"}>{myAgent ? "done" : "todo"}</StatusBadge>{" "}
            Register an agent
          </p>
          {!myAgent && (
            <Link className="btn btn-primary" href="/forge">
              Register an agent
            </Link>
          )}
        </li>
        <li className="surface detail-panel">
          <p className="hint">
            <StatusBadge tone={open.length > 0 ? "success" : "pending"}>{open.length > 0 ? "done" : "todo"}</StatusBadge>{" "}
            Post or claim a trial
          </p>
          {open.length === 0 && (
            <Link className="btn btn-primary" href="/trials">
              Browse trials
            </Link>
          )}
        </li>
      </ul>

      <SectionHeader title="Needs attention" subtitle="Failed, disputed, or pending actions." />
      {open.filter((t: any) => t.status === "challenged").length > 0 ? (
        <ul className="stack">
          {open
            .filter((t: any) => t.status === "challenged")
            .map((t: any) => (
              <li key={t.id} className="surface detail-panel">
                <p className="mono">
                  <Link href={`/trials/${t.id}`}>Trial #{t.id}</Link>
                </p>
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
              <p className="mono">
                <Link href={`/trials/${t.id}`}>Trial #{t.id}</Link>
              </p>
              <p className="hint">
                <VerdictBadge verdict={t.verdict} />
              </p>
              <p className="hint">
                <Link href={`/trials/${t.id}/replay`}>Watch replay</Link>{" "}
                <Link href={`/replay/${t.id}`}>Replay theater</Link>{" "}
                <Link href={`/ghost/${t.id}`}>Ghost fork</Link>
              </p>
            </li>
          ))}
        </ul>
      ) : (
        <EmptyState title="No verdicts yet" body="Settled trials will appear here." />
      )}

      <SectionHeader title="Quick actions" />
      <div className="engram-actions">
        <Link className="btn btn-primary" href="/trials/new">
          Post a trial
        </Link>
        <Link className="btn btn-ghost" href="/trials">
          Browse trials
        </Link>
        <Link className="btn btn-ghost" href="/escrow">
          View escrow
        </Link>
        <Link className="btn btn-ghost" href="/forge">
          Register agent
        </Link>
      </div>
    </Chrome>
  );
}

/**
 * The settled-verdict badge.
 *
 * It used to test `verdict === "pass"` — a value the chain never emits (verdicts are
 * paid/slashed/refunded/none), so every settled trial rendered as an error. The label
 * and tone come from `verdictMeta`, the one table the rest of the site reads; its tones
 * map onto the badge palette here instead of growing a second vocabulary.
 */
function VerdictBadge({ verdict }: { verdict: string | null | undefined }) {
  const meta = verdictMeta(verdict ?? "none");
  const tone: "success" | "error" | "neutral" | "pending" =
    meta.tone === "quench"
      ? "success"
      : meta.tone === "sear"
        ? "error"
        : meta.tone === "faint"
          ? "pending"
          : "neutral";
  return <StatusBadge tone={tone}>{meta.label}</StatusBadge>;
}
