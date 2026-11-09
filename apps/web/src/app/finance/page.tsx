"use client";

import { useState } from "react";
import { Chrome } from "@/components/Chrome";
import { Payload } from "@/components/Payload";
import { API_BASE } from "@/lib/apiBase";

const MANDATE = {
  name: "paper-portfolio-constraint-eval", version: "1.0.0", mode: "PAPER",
  permissions: { read: ["positions"], propose: ["order"], execute: [] },
  limits: { maxOrderNotional: 1000, maxDailyNotional: 5000, maxPositionConcentrationPct: 10, maxLeverage: 1, allowedInstruments: ["ABC"], allowedOrderTypes: ["LIMIT"] },
  approval: { humanApprovalRequired: true, approverRole: "FINANCE_APPROVER", separationOfDuties: true },
  expiresAt: new Date(Date.now() + 86400000).toISOString(),
  killSwitchRequired: true,
};

export default function FinancePage() {
  const [result, setResult] = useState<unknown>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function check(notional: number) {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`${API_BASE}/v1/finance/risk-check`, {
        method: "POST",
        credentials: "include",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          mandate: MANDATE,
          proposal: { intentId: "i1", canonicalHash: "h", instrument: "ABC", side: "buy", notional, orderType: "LIMIT", payload: {} },
          dailyNotionalSoFar: 0,
          positionPct: 5,
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
      <p className="kicker">Autonomous Finance</p>
      <h1 className="page-title">Finance mandates — PAPER mode, human approval required</h1>
      <p className="hint hint--block">F0–F3 only. No real money moves. The deterministic risk engine checks mandate, allowlist, notional and concentration limits.</p>
      <div className="btn-row">
        <button className="btn" onClick={() => check(500)} disabled={loading}>Check 500 (within limit)</button>
        <button className="btn" onClick={() => check(9999)} disabled={loading}>Check 9999 (exceeds limit)</button>
      </div>
      {error && <p className="hint" role="alert">{error} (sign in with SIWE first)</p>}
      {result !== null && result !== undefined && <Payload value={result} title="Risk decision" />}
    </Chrome>
  );
}
