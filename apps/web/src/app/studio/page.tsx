"use client";

import { useState } from "react";
import Link from "next/link";
import { Chrome, SignalLost } from "@/components/Chrome";
import { useAuthSession } from "@/lib/auth-session";

/**
 * The Evaluation Studio — the question "would this result repeat?".
 *
 * The verdict comes from the API, not from this page. The browser sends the
 * pinned task and the evidence each replay produced, and the API verifies
 * each replay through the real verifier and compares the EVIDENCE. A page
 * that computed the answer itself would be a page anybody could edit.
 *
 * The interface is three evidence boxes, because the rule is three replays:
 * a studio that let you check reproducibility with one run would be selling
 * the one thing the rule exists to prevent.
 */
type Verdict = "REPRODUCIBLE" | "NOT_REPRODUCIBLE" | "INCONCLUSIVE";

interface ReplayOutcome {
  replayNumber: number;
  label: string;
  status: string;
  checksAnswered: number;
  fingerprint: string | null;
  comparable: boolean;
  reason: string | null;
}

interface Report {
  verdict: Verdict;
  explanation: string;
  comparable: number;
  distinctFingerprints: number;
  requiredReplays: number;
  replays: ReplayOutcome[];
}

const EVIDENCE_TEMPLATE = JSON.stringify(
  [{ id: "check-1", passed: true, detail: "the pinned test passed", artifactDigest: "sha256:…" }],
  null,
  2,
);

export default function StudioPage() {
  const auth = useAuthSession();
  const [profile, setProfile] = useState("SOFTWARE_ENGINEERING");
  const [task, setTask] = useState("{}");
  const [evidence, setEvidence] = useState<string[]>([EVIDENCE_TEMPLATE, EVIDENCE_TEMPLATE, EVIDENCE_TEMPLATE]);
  const [busy, setBusy] = useState(false);
  const [report, setReport] = useState<Report | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function check() {
    setBusy(true);
    setReport(null);
    setError(null);
    try {
      const replays = evidence.map((raw, index) => {
        let parsed: unknown;
        try {
          parsed = JSON.parse(raw);
        } catch {
          throw new Error(`Replay ${index + 1} is not valid JSON.`);
        }
        return { label: `replay ${index + 1}`, evidence: parsed };
      });
      const res = await fetch(`${process.env.NEXT_PUBLIC_API_URL ?? "http://127.0.0.1:8787"}/v1/studio/reproducibility`, {
        method: "POST",
        credentials: "include",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ profile, task: JSON.parse(task || "{}"), replays }),
      });
      const body = await res.json().catch(() => null);
      if (!res.ok) {
        setError(
          body && typeof body === "object" && "error" in body
            ? String((body as { error: unknown }).error)
            : `The API answered with ${res.status}.`,
        );
        return;
      }
      setReport(body as Report);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Chrome>
      <p className="kicker">Evaluation Studio</p>
      <h1 className="page-title" id="studio-panel">Would this result repeat?</h1>
      <p className="lede">
        A run proves what happened once. The rule is three independent
        replays of the same pinned task, and an answer about whether they
        agreed. The API works that out; this page only shows it.
      </p>

      {!auth.isAuthenticated ? (
        <p className="surface detail-panel">
          <strong>Sign in to use the Studio.</strong>
          <p className="hint">
            Running a check costs the platform a run, so it asks who is asking.
          </p>
        </p>
      ) : null}

      {auth.isAuthenticated ? (
        <>
          <p className="surface detail-panel">
            <label className="hint" htmlFor="studio-profile">
              What kind of work is being evaluated
            </label>
            <select
              id="studio-profile"
              className="input"
              value={profile}
              onChange={(e) => setProfile(e.target.value)}
            >
              <option value="SOFTWARE_ENGINEERING">Software engineering</option>
              <option value="STRUCTURED_DATA">Structured data</option>
              <option value="AUTONOMOUS_FINANCE">Autonomous finance</option>
            </select>

            <label className="hint" htmlFor="studio-task">
              The pinned task
            </label>
            <textarea
              id="studio-task"
              className="input mono"
              rows={4}
              value={task}
              onChange={(e) => setTask(e.target.value)}
            />

            {evidence.map((raw, index) => (
              <div key={index}>
                <label className="hint" htmlFor={`studio-evidence-${index}`}>
                  Replay {index + 1} — what the runner observed
                </label>
                <textarea
                  id={`studio-evidence-${index}`}
                  className="input mono"
                  rows={4}
                  value={raw}
                  onChange={(e) =>
                    setEvidence((current) =>
                      current.map((value, i) => (i === index ? e.target.value : value)),
                    )
                  }
                />
              </div>
            ))}

            <button type="button" className="btn btn-primary" onClick={check} disabled={busy}>
              {busy ? "Running three replays…" : "Run the three replays and judge"}
            </button>
          </p>

          {error ? <SignalLost message={error} /> : null}

          {report ? (
            <>
              <h2 className="section-title">The answer</h2>
              <p className="surface detail-panel">
                <strong>{verdictWords(report.verdict)}</strong>
                <br />
                <span className="hint">{report.explanation}</span>
              </p>
              <div className="stack">
                {report.replays.map((replay) => (
                  <div key={replay.replayNumber} className="surface detail-panel">
                    <p>
                      <strong>Replay {replay.replayNumber}</strong> — {replay.label}
                    </p>
                    <p className="hint">
                      Verifier said: {replay.status}. Checks answered: {replay.checksAnswered}.
                    </p>
                    <p className="hint">
                      {replay.fingerprint
                        ? `Evidence digest: ${replay.fingerprint}.`
                        : "No evidence, so this replay could not be compared."}
                    </p>
                    {replay.reason ? <p className="hint">{replay.reason}</p> : null}
                  </div>
                ))}
              </div>
            </>
          ) : null}
        </>
      ) : null}

      <p className="hint hint--block">
        The rules the platform follows are written out on{" "}
        <Link className="mono" href="/docs">the docs page</Link>.
      </p>
    </Chrome>
  );
}

function verdictWords(verdict: Verdict): string {
  if (verdict === "REPRODUCIBLE") return "Yes — the three replays agreed.";
  if (verdict === "NOT_REPRODUCIBLE") return "No — the replays disagreed.";
  return "Not enough to say.";
}
