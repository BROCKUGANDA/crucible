"use client";

import { useState } from "react";
import { Chrome } from "@/components/Chrome";
import { API_BASE } from "@/lib/apiBase";
import { formatWei } from "@/lib/eth";

/**
 * Bounty Calculator — recommends an economically appropriate native ETH reward
 * based on execution cost, specialist effort, complexity, risk, and scarcity.
 * All amounts are exact integers (wei). No floating point.
 */
export default function BountyCalculatorPage() {
  const [orgId, setOrgId] = useState("");
  const [executionCost, setExecutionCost] = useState("");
  const [specialistEffort, setSpecialistEffort] = useState("");
  const [complexityPremium, setComplexityPremium] = useState("");
  const [riskPremium, setRiskPremium] = useState("");
  const [scarcityPremium, setScarcityPremium] = useState("");
  const [protocolFloor, setProtocolFloor] = useState("100000000000000000"); // 0.1 ETH
  const [modelConfidence, setModelConfidence] = useState("0.8");
  const [reason, setReason] = useState("Bounty recommendation for Forge Brief.");
  const [recommendation, setRecommendation] = useState<any>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function calculate(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setLoading(true);

    try {
      const res = await fetch(`${API_BASE}/forge/bounty/brief-calc`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({
          orgId,
          nativeAsset: "ETH",
          network: "31337",
          executionCost,
          specialistEffortValue: specialistEffort,
          complexityPremium,
          riskPremium,
          scarcityPremium,
          protocolFloor,
          modelConfidence: parseFloat(modelConfidence),
          calibrationDataDate: Date.now(),
          reason,
        }),
      });

      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.error || err.reason || "Failed to calculate bounty");
      }

      const body = await res.json();
      setRecommendation(body.recommendation);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unexpected error");
    } finally {
      setLoading(false);
    }
  }

  if (error) {
    return (
      <Chrome>
        <h1 className="page-title">Bounty Calculator</h1>
        <p className="mono" data-tone="sear" role="alert">{error}</p>
        <button
          className="btn btn-primary"
          onClick={() => window.location.reload()}
        >
          Try again
        </button>
      </Chrome>
    );
  }

  return (
    <Chrome>
      <h1 className="page-title">Bounty Calculator</h1>
      <p className="lede">
        Recommend an economically appropriate native ETH reward. All amounts are
        exact integers (wei). No floating point.
      </p>

      {loading ? (
        <p className="mono" data-tone="dim">Calculating…</p>
      ) : null}

      <form onSubmit={calculate} className="surface form-panel">
        <label className="field">
          <span className="kicker">Organisation</span>
          <input
            className="input"
            value={orgId}
            onChange={(e) => setOrgId(e.target.value)}
            placeholder="org-id"
            required
          />
        </label>

        <label className="field field--narrow">
          <span className="kicker">Execution cost (wei)</span>
          <input
            className="input mono"
            value={executionCost}
            onChange={(e) => setExecutionCost(e.target.value)}
            placeholder="0"
          />
        </label>

        <label className="field field--narrow">
          <span className="kicker">Specialist effort value (wei)</span>
          <input
            className="input mono"
            value={specialistEffort}
            onChange={(e) => setSpecialistEffort(e.target.value)}
            placeholder="0"
          />
        </label>

        <label className="field field--narrow">
          <span className="kicker">Complexity premium (wei)</span>
          <input
            className="input mono"
            value={complexityPremium}
            onChange={(e) => setComplexityPremium(e.target.value)}
            placeholder="0"
          />
        </label>

        <label className="field field--narrow">
          <span className="kicker">Risk premium (wei)</span>
          <input
            className="input mono"
            value={riskPremium}
            onChange={(e) => setRiskPremium(e.target.value)}
            placeholder="0"
          />
        </label>

        <label className="field field--narrow">
          <span className="kicker">Scarcity premium (wei)</span>
          <input
            className="input mono"
            value={scarcityPremium}
            onChange={(e) => setScarcityPremium(e.target.value)}
            placeholder="0"
          />
        </label>

        <label className="field field--narrow">
          <span className="kicker">Protocol floor (wei)</span>
          <input
            className="input mono"
            value={protocolFloor}
            onChange={(e) => setProtocolFloor(e.target.value)}
            placeholder="100000000000000000"
          />
        </label>

        <label className="field field--narrow">
          <span className="kicker">Model confidence (0-1)</span>
          <input
            className="input mono"
            value={modelConfidence}
            onChange={(e) => setModelConfidence(e.target.value)}
            placeholder="0.8"
          />
        </label>

        <label className="field">
          <span className="kicker">Reason</span>
          <input
            className="input"
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder="Bounty recommendation for Forge Brief."
          />
        </label>

        <button
          className="btn btn-primary"
          disabled={loading || !orgId}
          aria-busy={loading || undefined}
        >
          {loading ? "Calculating…" : "Calculate bounty"}
        </button>
      </form>

      {recommendation && (
        <section className="surface result-panel">
          <h2 className="section-title">Recommendation</h2>
          <div className="bounty-grid">
            <div className="metric-card">
              <p className="mono faint">Minimum recommended</p>
              <p className="mono">{formatWei(BigInt(recommendation.minimumRecommended))} ETH</p>
            </div>
            <div className="metric-card">
              <p className="mono faint">Competitive bounty</p>
              <p className="mono">{formatWei(BigInt(recommendation.competitiveBounty))} ETH</p>
            </div>
            <div className="metric-card">
              <p className="mono faint">Premium bounty</p>
              <p className="mono">{formatWei(BigInt(recommendation.premiumBounty))} ETH</p>
            </div>
            <div className="metric-card">
              <p className="mono faint">Required bond</p>
              <p className="mono">{formatWei(BigInt(recommendation.requiredBondWei))} ETH</p>
            </div>
            <div className="metric-card">
              <p className="mono faint">Protocol fee (5%)</p>
              <p className="mono">{formatWei(BigInt(recommendation.protocolFeeWei))} ETH</p>
            </div>
            <div className="metric-card">
              <p className="mono faint">Expected net payout</p>
              <p className="mono">{formatWei(BigInt(recommendation.expectedNetAgentPayoutWei))} ETH</p>
            </div>
          </div>
          <p className="mono faint">{recommendation.reason}</p>
          <p className="mono faint">
            Model confidence: {(recommendation.modelConfidence * 100).toFixed(0)}%
          </p>
        </section>
      )}
    </Chrome>
  );
}