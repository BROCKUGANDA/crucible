"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { Chrome } from "@/components/Chrome";
import { API_BASE } from "@/lib/apiBase";
import { formatEth } from "@/lib/forge";

interface ForgeBrief {
  briefId: string;
  sponsor: string;
  status: string;
  createdAt: number;
  updatedAt: number;
  objective: {
    title: string;
    domain: string;
    problemStatement: string;
    intendedOutcome: string;
    purpose: string;
    whyItMatters: string;
    expectedDeliverable: string;
  };
  requirements: Array<{
    id: string;
    text: string;
    mandatory: boolean;
    acceptanceCriteria: string[];
    outputFormat?: string;
    validationConditions?: string[];
    requiredEvidence?: string[];
  }>;
  complexity: {
    steps?: number;
    dependencyCount?: number;
    integrationComplexity?: string;
    dataVolume?: string;
    systemComplexity?: string;
    novelty?: string;
    ambiguity?: string;
    requiredSpecialistKnowledge?: string[];
    anticipatedExecutionTimeMs?: number;
  };
  environment: {
    allowedLanguages?: string[];
    frameworks?: string[];
    modelProviders?: string[];
    apis?: string[];
    tools?: string[];
    networkPermissions?: string[];
    filesystemPermissions?: string[];
    runtimeConstraints?: string[];
    computeLimits?: string;
    deploymentRequirements?: string[];
  };
  verification: {
    deterministicTestSuite?: boolean;
    hiddenHoldoutTests?: boolean;
    referenceSolution?: boolean;
    rubric?: string;
    humanReviewRequirements?: string[];
    requiredArtifactHashes?: string[];
    reproducibilityRequirements?: string[];
  };
  reliabilityAndRisk: {
    expectedReliability?: number;
    securitySensitivity?: string;
    financialSensitivity?: string;
    deadline?: number;
    failureImpact?: string;
    requiredRecoverability?: string;
    adversarialTestingRequirements?: string[];
    dataClassification?: string;
  };
  financialCommitment: {
    maxBudgetWei?: string;
    nativeAsset: string;
    network: string;
    proposedRewardWei?: string;
    stageRewardsWei?: string[];
    requiredDeadlineMs?: number;
    paymentTerms?: string;
    refundTerms?: string;
  };
}

interface DifficultyProfile {
  trialId: string;
  domain: string;
  estimatedDifficulty: number | null;
  estimatedConfidence: number | null;
  observedCompletionRate: number | null;
  observedFailureRate: number | null;
  baselineAgentCohort: string[] | null;
  sampleSize: number;
  confidenceInterval: [number, number] | null;
  calibrationDate: number | null;
  calibrationStatus: string;
  dimensions: {
    scores: Array<{
      dimension: string;
      value: number | null;
      confidence: number | null;
      basis: string;
    }>;
    composite: number | null;
  };
}

interface BountyRecommendation {
  trialId: string;
  nativeAsset: string;
  network: string;
  minimumRecommended: string;
  competitiveBounty: string;
  premiumBounty: string;
  executionCost: string;
  specialistEffortValue: string;
  complexityPremium: string;
  riskPremium: string;
  scarcityPremium: string;
  protocolFloor: string;
  requiredBondWei: string;
  maxAmountAtRiskWei: string;
  expectedNetAgentPayoutWei: string;
  protocolFeeWei: string;
  reason: string;
  modelConfidence: number;
  calibrationDataDate: number | null;
  computedAt: number;
}

interface ReadinessReport {
  briefId: string;
  status: string;
  checks: Record<string, boolean>;
  failures: string[];
  warnings: string[];
  nextStep: string;
}

/**
 * Forge Brief view — shows the brief, difficulty assessment, and bounty
 * recommendation. Three tabs: Brief, Heat Assessment, Bounty Calculator.
 */
export default function ForgeBriefViewPage({ params }: { params: { id: string } }) {
  const orgId = "";
  const [brief, setBrief] = useState<ForgeBrief | null>(null);
  const [difficulty, setDifficulty] = useState<DifficultyProfile | null>(null);
  const [bounty, setBounty] = useState<BountyRecommendation | null>(null);
  const [readiness, setReadiness] = useState<ReadinessReport | null>(null);
  const [tab, setTab] = useState<"brief" | "difficulty" | "bounty">("brief");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    loadBrief();
  }, [params.id]);

  async function loadBrief() {
    try {
      setLoading(true);
      const res = await fetch(`${API_BASE}/forge/brief/${params.id}?orgId=${orgId}`, {
        method: "GET",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
      });

      if (!res.ok) {
        if (res.status === 404) {
          setError("Brief not found");
          return;
        }
        throw new Error("Failed to load brief");
      }

      const body = await res.json();
      setBrief(body.brief);
      setReadiness(body.readiness);
      setDifficulty(null);
      setBounty(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unexpected error");
    } finally {
      setLoading(false);
    }
  }

  async function computeDifficulty() {
    if (!brief) return;
    setLoading(true);
    try {
      const res = await fetch(`${API_BASE}/forge/difficulty/${params.id}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({
          orgId,
          domain: brief.objective.domain,
        }),
      });

      if (!res.ok) {
        throw new Error("Failed to compute difficulty");
      }

      const body = await res.json();
      setDifficulty(body.profile);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unexpected error");
    } finally {
      setLoading(false);
    }
  }

  async function computeBounty() {
    if (!brief) return;
    setLoading(true);
    try {
      const res = await fetch(`${API_BASE}/forge/bounty/${params.id}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({
          orgId,
          nativeAsset: "ETH",
          network: "31337",
          executionCost: "100000000000000000",
          specialistEffortValue: "200000000000000000",
          complexityPremium: "50000000000000000",
          riskPremium: "30000000000000000",
          scarcityPremium: "20000000000000000",
          protocolFloor: "100000000000000000",
          modelConfidence: 0.8,
          reason: "Bounty recommendation for Forge Brief.",
        }),
      });

      if (!res.ok) {
        throw new Error("Failed to compute bounty");
      }

      const body = await res.json();
      setBounty(body.recommendation);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unexpected error");
    } finally {
      setLoading(false);
    }
  }

  async function validateBrief() {
    if (!brief) return;
    setLoading(true);
    try {
      const res = await fetch(`${API_BASE}/forge/brief/${params.id}/validate`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ orgId }),
      });

      if (!res.ok) {
        throw new Error("Failed to validate brief");
      }

      const body = await res.json();
      setReadiness(body.readiness);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unexpected error");
    } finally {
      setLoading(false);
    }
  }

  if (error) {
    return (
      <Chrome>
        <h1 className="page-title">Brief not found</h1>
        <p className="mono" data-tone="sear" role="alert">{error}</p>
        <Link className="btn btn-primary" href="/forge/brief">
          Create a brief
        </Link>
      </Chrome>
    );
  }

  if (!brief) {
    return (
      <Chrome>
        <h1 className="page-title">Forge Brief</h1>
        <p className="mono" data-tone="dim">Loading…</p>
      </Chrome>
    );
  }



  return (
    <Chrome>
      <header className="brief-head">
        <h1 className="page-title">Forge Brief</h1>
        <p className="mono break-card__id">ID {brief.briefId}</p>
        <div className="brief-tabs">
          <button
            className={`tab-btn ${tab === "brief" ? "tab-btn--active" : ""}`}
            onClick={() => setTab("brief")}
          >
            Brief
          </button>
          <button
            className={`tab-btn ${tab === "difficulty" ? "tab-btn--active" : ""}`}
            onClick={() => setTab("difficulty")}
          >
            Heat Assessment
          </button>
          <button
            className={`tab-btn ${tab === "bounty" ? "tab-btn--active" : ""}`}
            onClick={() => setTab("bounty")}
          >
            Bounty Calculator
          </button>
        </div>
      </header>

      {loading ? (
        <p className="mono" data-tone="dim">Loading…</p>
      ) : null}

      {tab === "brief" ? (
        <>
          <section className="surface brief-section">
            <h2 className="section-title">Challenge</h2>
            <p>{brief.objective.problemStatement}</p>
            <p className="mono faint">{brief.objective.intendedOutcome}</p>

            <h3 className="section-title">Requirements</h3>
            <ul className="requirement-list">
              {brief.requirements.map((r) => (
                <li key={r.id}>
                  <p>{r.text}</p>
                  {r.acceptanceCriteria.map((c, i) => (
                    <p key={i} className="mono faint indent-sm">
                      • {c}
                    </p>
                  ))}
                </li>
              ))}
            </ul>
          </section>

          <section className="surface brief-section">
            <h2 className="section-title">Readiness</h2>
            {readiness ? (
              <>
                <p className="mono">
                  Status:{" "}
                  <span
                    className={`mono ${
                      readiness.status === "ready_to_fund"
                        ? "data-tone-quench"
                        : readiness.status === "awaiting_review"
                          ? "data-tone-ember"
                          : "data-tone-sear"
                    }`}
                  >
                    {readiness.status}
                  </span>
                </p>
                {readiness.failures.length > 0 && (
                  <ul className="failure-list">
                    {readiness.failures.map((f) => (
                      <li key={f} className="mono faint">
                        • {f}
                      </li>
                    ))}
                  </ul>
                )}
                <p className="mono faint">{readiness.nextStep}</p>
                <button
                  className="btn btn-primary"
                  onClick={validateBrief}
                  disabled={loading}
                >
                  {loading ? "Validating…" : "Re-validate"}
                </button>
              </>
            ) : null}
          </section>
        </>
      ) : tab === "difficulty" ? (
        <>
          <section className="surface brief-section">
            <h2 className="section-title">Heat Assessment</h2>
            <p className="mono faint">
              Difficulty is measured, not declared. The sponsor's estimate is an
              input; Crucible's estimate is derived from the brief's complexity
              dimensions.
            </p>

            {difficulty ? (
              <>
                <div className="difficulty-grid">
                  <div className="metric-card">
                    <p className="mono faint">Estimated difficulty</p>
                    <p className="mono">
                      {difficulty.estimatedDifficulty?.toFixed(2) ?? "—"}
                    </p>
                    <p className="mono faint">
                      Confidence:{" "}
                      {difficulty.estimatedConfidence?.toFixed(2) ?? "—"}
                    </p>
                  </div>
                  <div className="metric-card">
                    <p className="mono faint">Sample size</p>
                    <p className="mono">{difficulty.sampleSize}</p>
                  </div>
                  <div className="metric-card">
                    <p className="mono faint">Calibration</p>
                    <p className="mono">{difficulty.calibrationStatus}</p>
                  </div>
                </div>

                <h3 className="section-title">Dimensions</h3>
                <div className="dimension-list">
                  {difficulty.dimensions.scores.map((d) => (
                    <div key={d.dimension} className="dimension-row">
                      <span className="mono faint">{d.dimension}</span>
                      <span className="mono">
                        {d.value?.toFixed(2) ?? "—"}
                      </span>
                      <span className="mono faint">{d.basis}</span>
                    </div>
                  ))}
                </div>
              </>
            ) : null}

            <button
              className="btn btn-primary"
              onClick={computeDifficulty}
              disabled={loading}
            >
              {loading ? "Computing…" : "Assess difficulty"}
            </button>
          </section>
        </>
      ) : (
        <>
          <section className="surface brief-section">
            <h2 className="section-title">Bounty Calculator</h2>
            <p className="mono faint">
              Reward is economically justified, not arbitrarily inflated. Higher
              rewards account for the additional bond they require.
            </p>

            {bounty ? (
              <>
                <div className="bounty-grid">
                  <div className="metric-card">
                    <p className="mono faint">Minimum recommended</p>
                    <p className="mono">{formatEth(bounty.minimumRecommended)} ETH</p>
                  </div>
                  <div className="metric-card">
                    <p className="mono faint">Competitive bounty</p>
                    <p className="mono">{formatEth(bounty.competitiveBounty)} ETH</p>
                  </div>
                  <div className="metric-card">
                    <p className="mono faint">Premium bounty</p>
                    <p className="mono">{formatEth(bounty.premiumBounty)} ETH</p>
                  </div>
                  <div className="metric-card">
                    <p className="mono faint">Required bond</p>
                    <p className="mono">{formatEth(bounty.requiredBondWei)} ETH</p>
                  </div>
                  <div className="metric-card">
                    <p className="mono faint">Protocol fee (5%)</p>
                    <p className="mono">{formatEth(bounty.protocolFeeWei)} ETH</p>
                  </div>
                  <div className="metric-card">
                    <p className="mono faint">Expected net payout</p>
                    <p className="mono">{formatEth(bounty.expectedNetAgentPayoutWei)} ETH</p>
                  </div>
                </div>

                <p className="mono faint">{bounty.reason}</p>
                <p className="mono faint">
                  Model confidence: {(bounty.modelConfidence * 100).toFixed(0)}%
                </p>
              </>
            ) : null}

            <button
              className="btn btn-primary"
              onClick={computeBounty}
              disabled={loading}
            >
              {loading ? "Computing…" : "Calculate bounty"}
            </button>
          </section>
        </>
      )}
    </Chrome>
  );
}