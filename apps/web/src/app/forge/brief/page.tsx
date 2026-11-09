"use client";

import { useState } from "react";
import Link from "next/link";
import { Chrome } from "@/components/Chrome";
import { API_BASE } from "@/lib/apiBase";
import { parseEth } from "@/lib/eth";
import { useAccount } from "wagmi";

/**
 * Forge Brief — the sponsor describes the problem before difficulty or reward
 * is calculated. The sponsor declares; Crucible measures.
 */
export default function ForgeBriefPage() {
  const { address } = useAccount();
  const [orgId, setOrgId] = useState("");
  const [title, setTitle] = useState("");
  const [domain, setDomain] = useState("");
  const [problemStatement, setProblemStatement] = useState("");
  const [intendedOutcome, setIntendedOutcome] = useState("");
  const [proposedRewardEth, setProposedRewardEth] = useState("");
  const [briefId, setBriefId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function createBrief(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setSuccess(null);
    setLoading(true);

    try {
      // Decimal ETH in, exact wei out. The old conversion multiplied a float by 1e18 —
      // the bug lib/eth.ts exists to forbid; parseEth reads digits, never doubles.
      const rewardWei = parseEth(proposedRewardEth);
      if (rewardWei === null) {
        setError("Reward must be a decimal ETH amount, e.g. 0.05");
        return;
      }
      const res = await fetch(`${API_BASE}/forge/brief`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({
          orgId,
          sponsor: address,
          title,
          domain,
          problemStatement,
          intendedOutcome,
          expectedDeliverable: intendedOutcome,
          purpose: "Sponsor-funded trial",
          whyItMatters: problemStatement,
          requirements: [
            {
              id: "req-1",
              text: problemStatement,
              mandatory: true,
              acceptanceCriteria: [intendedOutcome],
              validationConditions: ["Deterministic test suite"],
              requiredEvidence: ["Run artifact"],
            },
          ],
          complexity: {
            numberOfSteps: 1,
            dependencyCount: 0,
            integrationComplexity: "low",
            dataVolume: "small",
            systemComplexity: "low",
            novelty: "known",
            ambiguity: "low",
            anticipatedExecutionTimeMs: 3600000,
          },
          environment: {
            allowedLanguages: [],
            frameworks: [],
            modelProviders: [],
            apis: [],
            tools: [],
            networkPermissions: [],
            filesystemPermissions: [],
            runtimeConstraints: [],
            computeLimits: "standard",
            deploymentRequirements: [],
          },
          verification: {
            deterministicTestSuite: true,
            hiddenHoldoutTests: false,
            referenceSolution: false,
            rubric: "pass/fail",
            humanReviewRequirements: [],
            requiredArtifactHashes: [],
            reproducibilityRequirements: [],
          },
          reliabilityAndRisk: {
            expectedReliability: 0.9,
            securitySensitivity: "low",
            financialSensitivity: "low",
            failureImpact: "low",
            requiredRecoverability: "none",
            adversarialTestingRequirements: [],
            dataClassification: "public",
          },
          financialCommitment: {
            maxBudgetWei: rewardWei.toString(),
            nativeAsset: "ETH",
            network: "31337",
            proposedRewardWei: rewardWei.toString(),
          },
        }),
      });

      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.error || err.reason || "Failed to create brief");
      }

      const body = await res.json();
      setBriefId(body.brief.briefId);
      setSuccess(`Brief created: ${body.brief.briefId}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unexpected error");
    } finally {
      setLoading(false);
    }
  }

  return (
    <Chrome>
      <h1 className="page-title">Forge Brief</h1>
      <p className="lede">
        Describe the problem before Crucible calculates difficulty or recommends a reward.
        The sponsor declares; Crucible measures.
      </p>

      {loading ? (
        <p className="mono" data-tone="dim">Creating brief…</p>
      ) : null}
      {error ? (
        <p className="mono" data-tone="sear" role="alert">{error}</p>
      ) : null}
      {success ? (
        <>
          <p className="mono" data-tone="quench" role="status">{success}</p>
          <Link className="btn btn-primary" href={`/forge/brief/${briefId}`}>
            View brief
          </Link>
        </>
      ) : null}

      <form onSubmit={createBrief} className="surface form-panel">
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

        <label className="field">
          <span className="kicker">Challenge title</span>
          <input
            className="input"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="e.g. Reconcile two ledger datasets"
            required
          />
        </label>

        <label className="field">
          <span className="kicker">Domain</span>
          <input
            className="input"
            value={domain}
            onChange={(e) => setDomain(e.target.value)}
            placeholder="e.g. Financial reasoning"
            required
          />
        </label>

        <label className="field">
          <span className="kicker">Problem statement</span>
          <textarea
            className="input input--textarea"
            value={problemStatement}
            onChange={(e) => setProblemStatement(e.target.value)}
            rows={4}
            placeholder="What problem needs solving?"
            required
          />
        </label>

        <label className="field">
          <span className="kicker">Intended outcome</span>
          <textarea
            className="input input--textarea"
            value={intendedOutcome}
            onChange={(e) => setIntendedOutcome(e.target.value)}
            rows={3}
            placeholder="What does success look like?"
            required
          />
        </label>

        <label className="field field--narrow">
          <span className="kicker">Proposed reward (ETH)</span>
          <input
            className="input mono"
            value={proposedRewardEth}
            onChange={(e) => setProposedRewardEth(e.target.value)}
            inputMode="decimal"
            placeholder="0.1"
          />
        </label>

        <button
          className="btn btn-primary"
          disabled={loading || !orgId || !title || !domain || !problemStatement || !intendedOutcome}
          aria-busy={loading || undefined}
        >
          {loading ? "Creating…" : "Create brief"}
        </button>
      </form>
    </Chrome>
  );
}