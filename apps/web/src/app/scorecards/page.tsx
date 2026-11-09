"use client";

import { useEffect, useMemo, useState } from "react";
import { Chrome } from "@/components/Chrome";
import { API_BASE } from "@/lib/apiBase";
import { formatWhen } from "@/lib/clock";

interface ScorecardRow {
  modelId: string;
  suite: string;
  accuracy?: number;
  kappa?: number;
  falsePassRate?: number;
  disqualified?: boolean;
  disqualifyReason?: string;
  manifestDigest: string;
}

interface Publication {
  id: string;
  signer: string;
  signature: string;
  message: {
    cohort: string;
    chainId: number;
    agentId: number;
    runner: string;
    scorecardCid: string;
    scorecardDigest: string;
    issuedAt: number;
  };
  scorecard: {
    generatedAt: number;
    stage?: string;
    provider?: { kind?: string; model?: string; snapshot?: string };
    corpus?: { suite?: string; artifacts?: number };
    corpusEvidence: { cid: string; digest: string };
    trajectories: Array<{ claimHash: string; evidence: { cid: string; digest: string } }>;
    rows: ScorecardRow[];
  };
}

interface ScorecardResponse {
  configured: true;
  count: number;
  cohorts: string[];
  publications: Publication[];
}

function rate(value: unknown): string {
  return typeof value === "number" && Number.isFinite(value) ? `${(value * 100).toFixed(1)}%` : "—";
}

function when(seconds: number): string {
  // The shared formatter. `toLocaleString()` wrote the reader's locale into a chain
  // record, so one timestamp read differently on two machines.
  return formatWhen(seconds * 1000);
}

export default function ScorecardsPage() {
  const [data, setData] = useState<ScorecardResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [cohort, setCohort] = useState("");
  const [agent, setAgent] = useState("");

  useEffect(() => {
    const controller = new AbortController();
    fetch(`${API_BASE}/scorecards`, { signal: controller.signal, headers: { accept: "application/json" } })
      .then(async (response) => {
        if (!response.ok) {
          const body = await response.json().catch(() => null) as { error?: string } | null;
          throw new Error(body?.error ?? `Scorecards could not be verified (${response.status})`);
        }
        return response.json() as Promise<ScorecardResponse>;
      })
      .then(setData)
      .catch((cause: unknown) => {
        if (!controller.signal.aborted) {
          setError(cause instanceof Error ? cause.message : "Scorecards could not be verified");
        }
      });
    return () => controller.abort();
  }, []);

  const visible = useMemo(() => {
    const requestedAgent = agent.trim();
    return (data?.publications ?? []).filter((publication) =>
      (!cohort || publication.message.cohort === cohort) &&
      (!requestedAgent || String(publication.message.agentId) === requestedAgent),
    );
  }, [agent, cohort, data]);

  return (
    <Chrome>
      <p className="kicker">Verified evaluation results</p>
      <h1 className="page-title">Scorecards</h1>
      <p className="lede">
        Each result names its cohort and registered agent, carries an evaluator signature, and links to the
        pinned corpus and evidence used to produce it.
      </p>

      <section className="surface detail-panel scorecards-filters" aria-label="Filter scorecards">
        <label className="stack">
          <span>Cohort</span>
          <select value={cohort} onChange={(event) => setCohort(event.target.value)} disabled={!data}>
            <option value="">All cohorts</option>
            {data?.cohorts.map((value) => <option key={value} value={value}>{value}</option>)}
          </select>
        </label>
        <label className="stack">
          <span>Agent number</span>
          <input
            inputMode="numeric"
            pattern="[0-9]*"
            value={agent}
            onChange={(event) => setAgent(event.target.value.replace(/\D/g, ""))}
            placeholder="All agents"
          />
        </label>
        {data ? <span className="mono scorecards-count">{visible.length} verified result{visible.length === 1 ? "" : "s"}</span> : null}
      </section>

      {!data && !error ? <p className="hint">Checking signed publications and their pinned evidence…</p> : null}
      {error ? (
        <div className="surface detail-panel" role="status">
          <p className="kv"><span className="kv__key">Scorecards</span><span className="mono">not verified</span></p>
          <p className="hint">{error}. No score has been shown as an empty or zero result.</p>
        </div>
      ) : null}
      {data && visible.length === 0 ? (
        <div className="surface detail-panel" role="status">
          <p className="kv"><span className="kv__key">Results</span><span className="mono">none for this filter</span></p>
          <p className="hint">No signed scorecard matches the selected cohort and agent.</p>
        </div>
      ) : null}

      <div className="scorecards-list">
        {visible.map((publication) => (
          <article className="surface detail-panel scorecard-card" key={publication.id}>
            <div className="scorecard-card__heading">
              <div>
                <p className="kicker">Cohort {publication.message.cohort}</p>
                <h2>Agent #{publication.message.agentId}</h2>
              </div>
              <span className="chip">signature verified</span>
            </div>
            <dl className="scorecard-facts">
              <div><dt>Runner</dt><dd className="mono">{publication.message.runner}</dd></div>
              <div><dt>Chain</dt><dd>{publication.message.chainId}</dd></div>
              <div><dt>Evaluation</dt><dd>{publication.scorecard.provider?.model ?? "Model not recorded"}</dd></div>
              <div><dt>Suite</dt><dd>{publication.scorecard.corpus?.suite ?? "Suite not recorded"}</dd></div>
              <div><dt>Published</dt><dd>{when(publication.message.issuedAt)}</dd></div>
              <div><dt>Attestor</dt><dd className="mono">{publication.signer}</dd></div>
            </dl>

            <div className="table-wrap">
              <table className="table">
                <caption className="hint">Manifest digests were recomputed before this result was shown.</caption>
                <thead><tr><th scope="col">Model</th><th scope="col">Suite</th><th scope="col">Accuracy</th><th scope="col">False pass</th><th scope="col">Decision</th></tr></thead>
                <tbody>
                  {publication.scorecard.rows.map((row) => (
                    <tr key={`${row.modelId}-${row.suite}`}>
                      <td>{row.modelId}</td>
                      <td>{row.suite}</td>
                      <td className="mono">{rate(row.accuracy)}</td>
                      <td className="mono">{rate(row.falsePassRate)}</td>
                      <td>{row.disqualified ? `Disqualified${row.disqualifyReason ? ` · ${row.disqualifyReason}` : ""}` : "Qualified"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            <div className="scorecard-evidence">
              <a href={`${API_BASE}/scorecards/content/${publication.scorecard.corpusEvidence.cid}`} target="_blank" rel="noreferrer">
                Read pinned corpus ({publication.scorecard.corpus?.artifacts ?? "?"} probes)
              </a>
              {publication.scorecard.trajectories.map((trajectory) => (
                <a key={`${trajectory.claimHash}-${trajectory.evidence.cid}`} href={`${API_BASE}/scorecards/content/${trajectory.evidence.cid}`} target="_blank" rel="noreferrer">
                  Evidence {trajectory.claimHash.slice(0, 12)}…
                </a>
              ))}
              <a href={`${API_BASE}/scorecards/content/${publication.message.scorecardCid}`} target="_blank" rel="noreferrer">Read full signed scorecard</a>
            </div>
            <details className="scorecard-signature">
              <summary>Publication receipt</summary>
              <p className="mono">ID {publication.id}</p>
              <p className="mono">Scorecard digest {publication.message.scorecardDigest}</p>
              <p className="mono">Signature {publication.signature}</p>
            </details>
          </article>
        ))}
      </div>
    </Chrome>
  );
}
