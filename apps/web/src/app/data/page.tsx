"use client";

import { useState } from "react";
import { Chrome } from "@/components/Chrome";
import { API_BASE } from "@/lib/apiBase";

const CONTRACT = {
  name: "normalized-transactions", version: "1.2.0",
  schema: { type: "object", required: ["transaction_id", "amount"], properties: { transaction_id: { type: "string" }, amount: { type: "number" } } },
  quality: { unique: ["transaction_id"] },
  security: { classification: "confidential", piiRedactionRequired: true },
};

export default function DataPage() {
  const [result, setResult] = useState<unknown>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function validate() {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`${API_BASE}/v1/data/validate`, {
        method: "POST",
        credentials: "include",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          contract: CONTRACT,
          rows: [
            { transaction_id: "a", amount: 1 },
            { transaction_id: "a", amount: 2 },
          ],
        }),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error ?? `HTTP ${res.status}`);
      setResult(body);
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { setLoading(false); }
  }

  return (
    <Chrome>
      <p className="kicker">Structured Data &amp; ETL</p>
      <h1 className="page-title">Data contracts — schema, quality, reconciliation</h1>
      <p className="hint hint--block">Demo ships duplicate keys on purpose: uniqueness check fails, PII policy passes, reconciliation reports row counts.</p>
      <button className="btn" onClick={validate} disabled={loading}>{loading ? "Checking…" : "Validate demo dataset"}</button>
      {error && <p className="hint" role="alert">{error} (sign in with SIWE first)</p>}
      {result !== null && result !== undefined && <pre className="code">{JSON.stringify(result as Record<string, unknown>, null, 2)}</pre>}
    </Chrome>
  );
}
