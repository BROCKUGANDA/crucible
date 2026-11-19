import { describe, expect, it } from "vitest";
import {
  ManualMetaDaoAdapter,
  isUnsupported,
  validateEvidence,
  type EvidenceRecord,
  type MetaDaoProjectSnapshot,
} from "../src/metadao.js";

const HASH = "a".repeat(64);

const evidence: EvidenceRecord = {
  kind: "signed-document",
  uri: "s3://stamp-evidence/metadao-approval.pdf",
  sha256: HASH,
  reviewer: "counsel@example.com",
  recordedAt: "2026-11-09T00:00:00Z",
  sourceUrl: "https://metadao.com/docs/stamp",
};

const project: MetaDaoProjectSnapshot = {
  projectRef: "metadao-1",
  name: "Crucible",
  approvedWallet: "wallet",
  approvedStablecoinMint: "usdc",
  tokenMint: "token",
  governanceUrl: "https://metadao.com/g/crucible",
  saleUrl: "https://metadao.com/s/crucible",
  evidence: [evidence],
};

describe("manual MetaDAO adapter", () => {
  it("declares automation unsupported and lookups supported", async () => {
    const adapter = new ManualMetaDaoAdapter();
    const caps = await adapter.capabilities();
    expect(caps.deliveryAutomation).toBe("UNSUPPORTED");
    expect(caps.vestingAutomation).toBe("UNSUPPORTED");
    expect(caps.intakeSubmission).toBe("UNSUPPORTED");
    expect(caps.projectLookup).toBe("SUPPORTED");
    expect(caps.adapterVersion).toBe("metadao-manual/1.0.0");
  });

  it("answers UNSUPPORTED, not a placeholder success, for an unrecorded project", async () => {
    const adapter = new ManualMetaDaoAdapter();
    const result = await adapter.getProject("nope");
    expect(isUnsupported(result)).toBe(true);
    if (isUnsupported(result)) expect(result.reason).toMatch(/no reviewer-recorded/);
  });

  it("returns the recorded snapshot when a reviewer captured one", async () => {
    const adapter = new ManualMetaDaoAdapter({ projects: new Map([["metadao-1", project]]) });
    const result = await adapter.getProject("metadao-1");
    expect(isUnsupported(result)).toBe(false);
    if (!isUnsupported(result)) expect(result.approvedWallet).toBe("wallet");
  });

  it("answers UNSUPPORTED for every other capability it cannot automate", async () => {
    const adapter = new ManualMetaDaoAdapter();
    expect(isUnsupported(await adapter.getCanonicalTokenEvent("e1"))).toBe(true);
    expect(isUnsupported(await adapter.getTreasurySnapshot("p1"))).toBe(true);
    expect(isUnsupported(await adapter.getGovernanceLinks("p1"))).toBe(true);
  });
});

describe("evidence validation", () => {
  it("accepts evidence with a reviewer, a hash and a timestamp", () => {
    expect(validateEvidence([evidence])).toEqual([]);
  });

  it("refuses an empty evidence set", () => {
    expect(validateEvidence([])).toContain("no evidence attached");
  });

  it("refuses evidence with no named reviewer", () => {
    expect(validateEvidence([{ ...evidence, reviewer: "  " }]).join(" ")).toMatch(/no named reviewer/);
  });

  it("refuses evidence without a SHA-256", () => {
    expect(validateEvidence([{ ...evidence, sha256: "abc" }]).join(" ")).toMatch(/does not carry a SHA-256/);
  });

  it("refuses a URL record with no source", () => {
    expect(
      validateEvidence([{ ...evidence, kind: "url", sourceUrl: null }]).join(" "),
    ).toMatch(/URL with no source/);
  });
});