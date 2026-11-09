"use client";

import { useEffect, useState } from "react";
import { Chrome } from "@/components/Chrome";
import { Payload } from "@/components/Payload";
import { API_BASE } from "@/lib/apiBase";

export default function EngineeringPage() {
  const [workloads, setWorkloads] = useState<unknown>(null);
  const [run, setRun] = useState<unknown>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetch(`${API_BASE}/v1/workloads`).then((r) => r.json()).then(setWorkloads).catch(() => {});
  }, []);

  async function submitRun() {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`${API_BASE}/v1/runs`, {
        method: "POST",
        credentials: "include",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          profile: "SOFTWARE_ENGINEERING",
          trialId: "eng-regression-demo",
          task: {
            slug: "worker-idempotency-repair", version: "1.0.0",
            repositorySnapshot: "sha256:demo", baseCommit: "deadbeef",
            baselineCommand: ["pnpm", "test"], expectedExitCode: 1,
            checks: [
              { id: "baseline_reproduction", required: true },
              { id: "public_regression", required: true },
              { id: "hidden_regression", required: true },
              { id: "forbidden_diff", required: true },
            ],
            rubricId: "engineering-regression-v1",
          },
        }),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error ?? `HTTP ${res.status}`);
      setRun(body);
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { setLoading(false); }
  }

  return (
    <Chrome>
      <p className="kicker">Software Engineering</p>
      <h1 className="page-title">Engineering trials — deterministic regression repair</h1>
      <p className="hint hint--block">Baseline fails before the patch; accepted patch passes public + hidden regression; tampering is policy violation, infrastructure failure is rerun.</p>
      <button className="btn" onClick={submitRun} disabled={loading}>{loading ? "Running…" : "Run demo regression repair"}</button>
      {error && <p className="hint" role="alert">{error} (sign in with SIWE first)</p>}
      {run !== null && run !== undefined && <Payload value={run} title="Run result" />}
      {workloads !== null && workloads !== undefined && <Payload value={workloads} title="Advertised workloads" />}
    </Chrome>
  );
}
