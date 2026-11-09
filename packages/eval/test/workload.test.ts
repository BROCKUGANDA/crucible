import { describe, expect, it } from "vitest";
import {
  canTransition,
  validateManifest,
  getAdapter,
  listAdapters,
  validateEngineeringTask,
  validateDataContract,
  checkRows,
  validateMandate,
  riskCheck,
  type RunContext,
} from "../src/index.js";

const ctx = (): RunContext => ({
  runId: "run_1",
  attemptId: "att_1",
  tenantId: "tenant_1",
  trialId: "trial_1",
  trialRevisionId: "rev_1",
  workloadProfile: "SOFTWARE_ENGINEERING",
  environmentDigest: "sha256:runner",
  deadlineAt: new Date(Date.now() + 60000).toISOString(),
  idempotencyKey: "idem_1",
  abortSignal: new AbortController().signal,
});

describe("workload contracts (WP0)", () => {
  it("state machine: DRAFT→VALIDATED→PUBLISHED→QUEUED path exists", () => {
    expect(canTransition("DRAFT", "VALIDATED")).toBe(true);
    expect(canTransition("VALIDATED", "PUBLISHED")).toBe(true);
    expect(canTransition("PUBLISHED", "QUEUED")).toBe(true);
    expect(canTransition("QUEUED", "RUNNING")).toBe(false); // must admit first
    expect(canTransition("FAILED_INFRASTRUCTURE", "QUEUED")).toBe(false); // terminal
  });

  it("manifest pins all required fields", () => {
    expect(validateManifest({
      runId: "r", attemptId: "a", tenantId: "t", trialId: "tr", trialRevisionId: "v",
      workloadProfile: "SOFTWARE_ENGINEERING", adapterVersion: "1", taskDigest: "d",
      runnerImageDigest: "img", evaluatorVersion: "e", rubricVersion: "r",
      startedAt: 0, artifactDigests: [],
    })).toEqual([]);
    expect(validateManifest({ runId: "" } as never).length).toBeGreaterThan(0);
  });

  it("adapter registry covers all profiles incl. Solana engineering", () => {
    expect(listAdapters()).toHaveLength(4);
    expect(getAdapter("SOFTWARE_ENGINEERING").profile).toBe("SOFTWARE_ENGINEERING");
    expect(getAdapter("STRUCTURED_DATA").profile).toBe("STRUCTURED_DATA");
    expect(getAdapter("AUTONOMOUS_FINANCE").profile).toBe("AUTONOMOUS_FINANCE");
    expect(getAdapter("SOLANA_ENGINEERING")).toBeDefined();
  });
});

describe("software engineering (WP1)", () => {
  it("validates a regression-repair task package", () => {
    const ok = {
      slug: "worker-idempotency-repair", version: "1.0.0",
      repositorySnapshot: "sha256:abc", baseCommit: "deadbeef",
      baselineCommand: ["pnpm", "test"], expectedExitCode: 1,
      checks: [
        { id: "baseline_reproduction", required: true },
        { id: "public_regression", required: true },
        { id: "hidden_regression", required: true },
        { id: "forbidden_diff", required: true },
      ],
      rubricId: "engineering-regression-v1",
    };
    expect(validateEngineeringTask(ok).valid).toBe(true);
    expect(validateEngineeringTask({}).valid).toBe(false);
  });

  it("adapter prepares a manifest with pinned digests", async () => {
    const a = getAdapter("SOFTWARE_ENGINEERING");
    const prep = await a.prepare({
      slug: "s", version: "1", repositorySnapshot: "sha256:x", baseCommit: "c",
      baselineCommand: ["t"], expectedExitCode: 1,
      checks: [
        { id: "baseline_reproduction", required: true },
        { id: "public_regression", required: true },
        { id: "hidden_regression", required: true },
        { id: "forbidden_diff", required: true },
      ],
      rubricId: "r",
    }, ctx());
    expect(prep.manifest.runId).toBe("run_1");
    expect(prep.manifest.runnerImageDigest).toBe("sha256:runner");
  });
});

describe("structured data (WP5)", () => {
  const contract = {
    name: "normalized-transactions", version: "1.2.0",
    schema: { type: "object" as const, required: ["transaction_id", "amount"], properties: { transaction_id: { type: "string" }, amount: { type: "number" } } },
    quality: { unique: ["transaction_id"] },
    security: { classification: "confidential" as const, piiRedactionRequired: true },
  };

  it("validates a data contract", () => {
    expect(validateDataContract(contract).valid).toBe(true);
    expect(validateDataContract({}).valid).toBe(false);
  });

  it("checkRows detects duplicates, missing fields, and PII violations", () => {
    const dup = checkRows(contract, [
      { transaction_id: "a", amount: 1 },
      { transaction_id: "a", amount: 2 },
    ]);
    expect(dup.find((c) => c.id === "quality_uniqueness")!.passed).toBe(false);

    const pii = checkRows(contract, [{ transaction_id: "b", amount: 1, email: "x@y" }]);
    expect(pii.find((c) => c.id === "pii_policy")!.passed).toBe(false);

    const good = checkRows(contract, [{ transaction_id: "c", amount: 1 }]);
    expect(good.every((c) => c.passed)).toBe(true);
  });
});

describe("autonomous finance (WP8)", () => {
  const mandate = {
    name: "paper-portfolio-constraint-eval", version: "1.0.0", mode: "PAPER" as const,
    permissions: { read: ["positions"], propose: ["order"], execute: [] },
    limits: { maxOrderNotional: 1000, maxDailyNotional: 5000, maxPositionConcentrationPct: 10, maxLeverage: 1, allowedInstruments: ["ABC"], allowedOrderTypes: ["LIMIT"] },
    approval: { humanApprovalRequired: true, approverRole: "FINANCE_APPROVER", separationOfDuties: true },
    expiresAt: new Date(Date.now() + 86400000).toISOString(),
    killSwitchRequired: true,
  };

  it("PAPER mandate cannot hold execute permissions", () => {
    expect(validateMandate(mandate).valid).toBe(true);
    expect(validateMandate({ ...mandate, permissions: { ...mandate.permissions, execute: ["order"] } }).valid).toBe(false);
  });

  it("risk engine enforces notional, daily, concentration, allowlist", () => {
    const proposal = { intentId: "i1", canonicalHash: "h", instrument: "ABC", side: "buy" as const, notional: 500, orderType: "LIMIT", payload: {} };
    const ok = riskCheck(mandate, proposal, { dailyNotionalSoFar: 0, positionPct: 5 });
    expect(ok.every((c) => c.passed)).toBe(true);

    const over = riskCheck(mandate, { ...proposal, notional: 9999 }, { dailyNotionalSoFar: 0, positionPct: 5 });
    expect(over.find((c) => c.id === "notional_within_limit")!.passed).toBe(false);

    const badInstr = riskCheck(mandate, { ...proposal, instrument: "XYZ" }, { dailyNotionalSoFar: 0, positionPct: 5 });
    expect(badInstr.find((c) => c.id === "instrument_allowed")!.passed).toBe(false);
  });
});
