import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

/**
 * Mainnet preflight template invariants (blueprint §5, mainnet gates).
 *
 * The preflight script (`scripts/mainnet-preflight.mjs`) is a standalone
 * CLI that requires RPC access and live on-chain state for the deep Safe
 * checks — both unavailable in unit tests. These tests verify the logic the
 * script enforces: the 5% fee invariant, that production signoff templates
 * carry the required structure/fields, and that operator-authorized signoffs
 * remain structurally valid. On-chain Safe/escrow verification is covered by
 * `packages/eval/test/mainnet-preflight.test.ts` against a deterministic RPC
 * fixture.
 */

const SIGNOFF_DIR = "docs/mainnet";

function loadTemplate(name: string): { signed: boolean; [key: string]: unknown } {
  const raw = readFileSync(`${SIGNOFF_DIR}/${name}.json`, "utf-8");
  return JSON.parse(raw) as { signed: boolean; [key: string]: unknown };
}

describe("mainnet preflight: fee invariant (gate 7)", () => {
  it("v1 fee is frozen at 500 bps (5%)", () => {
    const params = JSON.parse(readFileSync("params/crucible.params.json", "utf-8")) as {
      legacy_fee_bps_v1_frozen: number;
    };
    expect(params.legacy_fee_bps_v1_frozen).toBe(500);
  });

  it("no yield on collateral (yield_forfeit_bps = 0)", () => {
    const params = JSON.parse(readFileSync("params/crucible.params.json", "utf-8")) as {
      yield_forfeit_bps: number;
    };
    expect(params.yield_forfeit_bps).toBe(0);
  });

  it("rounding floors remainder to treasury", () => {
    const params = JSON.parse(readFileSync("params/crucible.params.json", "utf-8")) as {
      rounding: string;
    };
    expect(params.rounding).toBe("floor_remainder_to_treasury");
  });
});

describe("mainnet preflight: production signoffs are operator-authorized and complete", () => {
  for (const name of [
    "audit-signoff",
    "legal-signoff",
    "genesis-cohort",
    "timelock",
    "monitoring",
    "treasury",
  ]) {
    it(`${name}.json is signed`, () => {
      expect(loadTemplate(name).signed).toBe(true);
    });
  }

  it("audit-signoff.json has required fields and a commit SHA", () => {
    const t = loadTemplate("audit-signoff") as Record<string, unknown>;
    expect(String(t.auditor)).not.toBe("");
    expect(String(t.reportHash)).toMatch(/^0x[0-9a-fA-F]{64}$/);
    expect(String(t.commit)).toMatch(/^[0-9a-f]{7,40}$/i);
  });

  it("audit-signoff.commit matches treasury.deploymentCommit", () => {
    const audit = loadTemplate("audit-signoff") as Record<string, unknown>;
    const treasury = loadTemplate("treasury") as Record<string, unknown>;
    expect(String(treasury.deploymentCommit).toLowerCase()).toBe(String(audit.commit).toLowerCase());
  });

  it("legal-signoff.json has required fields", () => {
    const t = loadTemplate("legal-signoff") as Record<string, unknown>;
    expect(String(t.entity)).not.toBe("");
    expect(String(t.counsel)).not.toBe("");
    expect(String(t.tosVersion)).not.toBe("");
  });

  it("genesis-cohort.json has sponsors, agents, and a cap", () => {
    const t = loadTemplate("genesis-cohort") as Record<string, unknown>;
    expect(Array.isArray(t.sponsors) && (t.sponsors as unknown[]).length > 0).toBe(true);
    expect(Array.isArray(t.agents) && (t.agents as unknown[]).length > 0).toBe(true);
    expect(Number(t.epochCapEth)).toBeGreaterThan(0);
  });

  it("timelock.json declares multisig and signers", () => {
    const t = loadTemplate("timelock") as Record<string, unknown>;
    expect(String(t.multisig)).not.toBe("");
    expect(Array.isArray(t.signers) && (t.signers as unknown[]).length > 0).toBe(true);
    expect(Number(t.timelockHours)).toBeGreaterThanOrEqual(24);
  });

  it("monitoring.json names oncall, alert channel, and dashboards", () => {
    const t = loadTemplate("monitoring") as Record<string, unknown>;
    expect(String(t.oncall)).not.toBe("");
    expect(String(t.alertChannel)).not.toBe("");
    expect(Array.isArray(t.dashboards) && (t.dashboards as unknown[]).length > 0).toBe(true);
  });
});

describe("mainnet preflight: treasury structure", () => {
  it("treasury.json pins chain 1 / native-ETH and required evidence fields", () => {
    const t = loadTemplate("treasury") as Record<string, unknown>;
    expect(t.chainId).toBe(1);
    expect(t.asset).toBe("native-ETH");
    expect(String(t.canonicalDeploymentSource)).toMatch(
      /^https:\/\/(github\.com\/safe-fndn\/safe-deployments|github\.com\/safe-global\/safe-deployments)\//,
    );
    expect(String(t.deploymentCommit)).toMatch(/^[0-9a-f]{7,40}$/i);
    expect(String(t.evidenceHash)).toMatch(/^0x[0-9a-fA-F]{64}$/);
    expect(String(t.verifiedBy)).not.toBe("");
  });

  it("treasury.json carries Treasury and Owner Safe records with 2-of-3 pilot policy (addresses pending deployment)", () => {
    const t = loadTemplate("treasury") as any;
    expect(t.treasurySafe).toBeDefined();
    expect(t.ownerSafe).toBeDefined();
    // Pre-deployment: Safe proxy/singleton addresses and hashes are placeholders
    // until real Safes are deployed on mainnet. mainnet-preflight's deep
    // on-chain verification (G6/TS-01) correctly blocks until those are real.
    for (const safe of [t.treasurySafe, t.ownerSafe]) {
      expect(safe.threshold).toBe(2);
      expect(Array.isArray(safe.owners) && safe.owners.length === 3).toBe(true);
      expect(safe.modules).toEqual([]);
      expect(safe.guard).toBe("0x0000000000000000000000000000000000000000");
      expect(safe.moduleGuard).toBe("0x0000000000000000000000000000000000000000");
      expect(safe.fallbackHandler).toBe("0x0000000000000000000000000000000000000000");
      expect(typeof safe.address).toBe("string");
      expect(typeof safe.singletonRuntimeCodeHash).toBe("string");
      expect(typeof safe.proxyRuntimeCodeHash).toBe("string");
    }
  });

  it("treasury.json escrows.legacyTrials is present (pre-deployment address may be empty)", () => {
    const t = loadTemplate("treasury") as any;
    expect(t.escrows).toBeDefined();
    expect(t.escrows.legacyTrials).toBeDefined();
    expect(typeof t.escrows.legacyTrials.address).toBe("string");
  });
});
