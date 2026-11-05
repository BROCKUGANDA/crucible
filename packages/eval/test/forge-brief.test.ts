/**
 * @file forge-brief.test.ts — Forge Brief schema and validation tests.
 */

import { describe, it, expect } from "vitest";
import {
  newForgeBrief,
  validateForgeBrief,
  newReadinessReport,
  computeBriefDigest,
  sealBrief,
} from "../src/forge-brief.js";

describe("newForgeBrief", () => {
  it("creates a draft brief with required fields", () => {
    const b = newForgeBrief("brief-1", "0xsponsor");
    expect(b.briefId).toBe("brief-1");
    expect(b.sponsor).toBe("0xsponsor");
    expect(b.status).toBe("draft");
    expect(b.version).toBe("1.0");
    expect(b.digest).toBeUndefined();
    expect(b.objective.title).toBe("");
    expect(b.requirements).toHaveLength(0);
  });

  it("throws on missing briefId or sponsor", () => {
    expect(() => newForgeBrief("", "0xsponsor")).toThrow();
    expect(() => newForgeBrief("brief-1", "")).toThrow();
  });
});

describe("validateForgeBrief", () => {
  it("fails validation for an empty brief", () => {
    const b = newForgeBrief("brief-1", "0xsponsor");
    const report = validateForgeBrief(b);
    expect(report.status).toBe("validation_failed");
    expect(report.failures.length).toBeGreaterThan(0);
    expect(report.checks.schema_valid).toBe(false);
    expect(report.nextStep).toContain("Resolve validation failures");
  });

  it("passes validation for a complete brief", () => {
    const b = newForgeBrief("brief-1", "0xsponsor");
    b.objective.title = "Reconcile ledgers";
    b.objective.domain = "finance";
    b.objective.problemStatement = "Reconcile two transaction datasets.";
    b.objective.intendedOutcome = "A reconciliation report.";
    b.objective.expectedDeliverable = "Report PDF.";
    b.objective.purpose = "Financial accuracy.";
    b.objective.whyItMatters = "Compliance.";
    b.requirements.push({
      id: "req-1",
      text: "Detect duplicates.",
      mandatory: true,
      acceptanceCriteria: ["All duplicates are flagged."],
      validationConditions: ["Run on test dataset."],
      requiredEvidence: ["Report."],
    });
    b.verification.deterministicTestSuite = true;
    // Under 0.1 ETH threshold so it doesn't trigger human review.
    b.financialCommitment.proposedRewardWei = 50_000_000_000_000_000n; // 0.05 ETH
    b.reliabilityAndRisk.deadlineMs = Date.now() + 86400000;
    b.complexity.ambiguity = "low";

    const report = validateForgeBrief(b);
    expect(report.status).toBe("ready_to_fund");
    expect(report.failures).toHaveLength(0);
    expect(report.checks.schema_valid).toBe(true);
    expect(report.checks.reward_appropriate).toBe(true);
    expect(report.checks.deadline_realistic).toBe(true);
  });

  it("flags high-value challenges for review", () => {
    const b = newForgeBrief("brief-1", "0xsponsor");
    b.objective.title = "T";
    b.objective.domain = "d";
    b.objective.problemStatement = "p";
    b.objective.intendedOutcome = "o";
    b.objective.expectedDeliverable = "e";
    b.objective.purpose = "p";
    b.objective.whyItMatters = "w";
    b.requirements.push({
      id: "req-1",
      text: "t",
      mandatory: true,
      acceptanceCriteria: ["c"],
      validationConditions: ["c"],
    });
    b.verification.deterministicTestSuite = true;
    // > 0.1 ETH triggers review
    b.financialCommitment.proposedRewardWei = 200_000_000_000_000_000n;
    b.reliabilityAndRisk.deadlineMs = Date.now() + 86400000;
    b.complexity.ambiguity = "low";

    const report = validateForgeBrief(b);
    expect(report.status).toBe("awaiting_review");
    expect(report.nextStep).toContain("human review");
  });

  it("rejects zero or negative reward", () => {
    const b = newForgeBrief("brief-1", "0xsponsor");
    b.objective.title = "T";
    b.objective.domain = "d";
    b.objective.problemStatement = "p";
    b.objective.intendedOutcome = "o";
    b.objective.expectedDeliverable = "e";
    b.objective.purpose = "p";
    b.objective.whyItMatters = "w";
    b.financialCommitment.proposedRewardWei = 0n;
    const report = validateForgeBrief(b);
    expect(report.checks.reward_appropriate).toBe(false);
    expect(report.failures.some((f) => f.includes("greater than zero"))).toBe(true);
  });

  it("rejects past deadline", () => {
    const b = newForgeBrief("brief-1", "0xsponsor");
    b.objective.title = "T";
    b.objective.domain = "d";
    b.objective.problemStatement = "p";
    b.objective.intendedOutcome = "o";
    b.objective.expectedDeliverable = "e";
    b.objective.purpose = "p";
    b.objective.whyItMatters = "w";
    b.reliabilityAndRisk.deadlineMs = Date.now() - 1000;
    const report = validateForgeBrief(b);
    expect(report.checks.deadline_realistic).toBe(false);
  });
});

describe("computeBriefDigest and sealBrief", () => {
  it("computes a stable digest", () => {
    const b = newForgeBrief("brief-1", "0xsponsor");
    b.objective.title = "T";
    const d1 = computeBriefDigest(b);
    const d2 = computeBriefDigest(b);
    expect(d1).toBe(d2);
    expect(d1.length).toBe(64); // sha256 hex
  });

  it("digest changes when content changes", () => {
    const b1 = newForgeBrief("brief-1", "0xsponsor");
    b1.objective.title = "A";
    const b2 = newForgeBrief("brief-1", "0xsponsor");
    b2.objective.title = "B";
    expect(computeBriefDigest(b1)).not.toBe(computeBriefDigest(b2));
  });

  it("sealBrief sets digest and updates timestamp", () => {
    const b = newForgeBrief("brief-1", "0xsponsor");
    b.objective.title = "T";
    const sealed = sealBrief(b);
    expect(sealed.digest).toBeDefined();
    expect(sealed.digest).toBe(computeBriefDigest(sealed));
    expect(sealed.updatedAt).toBeGreaterThanOrEqual(b.updatedAt);
    // Original is unchanged.
    expect(b.digest).toBeUndefined();
  });
});

describe("newReadinessReport", () => {
  it("creates a draft report", () => {
    const r = newReadinessReport("brief-1");
    expect(r.briefId).toBe("brief-1");
    expect(r.status).toBe("draft");
    expect(r.failures).toHaveLength(0);
    expect(r.nextStep).toContain("Complete the Forge Brief");
  });
});