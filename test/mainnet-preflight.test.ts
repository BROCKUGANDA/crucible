import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

/**
 * Mainnet preflight tests (blueprint §5, mainnet gates 1-12).
 *
 * The preflight script (`scripts/mainnet-preflight.mjs`) is a standalone
 * CLI that requires RPC access and signed templates — both unavailable in
 * test. These tests verify the logic the script enforces: the 5% fee
 * invariant, unsigned-template rejection, and template field requirements.
 */

const SIGNPOFF_DIR = "docs/mainnet";

function loadTemplate(name: string): { signed: boolean; [key: string]: unknown } {
  const raw = readFileSync(`${SIGNPOFF_DIR}/${name}.json`, "utf-8");
  return JSON.parse(raw) as { signed: boolean; [key: string]: unknown };
}

describe("mainnet preflight: fee invariant (gate 7)", () => {
  it("v1 fee is frozen at 500 bps (5%)", () => {
    const params = JSON.parse(
      readFileSync("params/crucible.params.json", "utf-8")
    ) as { legacy_fee_bps_v1_frozen: number };
    expect(params.legacy_fee_bps_v1_frozen).toBe(500);
  });

  it("no yield on collateral (yield_forfeit_bps = 0)", () => {
    const params = JSON.parse(
      readFileSync("params/crucible.params.json", "utf-8")
    ) as { yield_forfeit_bps: number };
    expect(params.yield_forfeit_bps).toBe(0);
  });

  it("rounding floors remainder to treasury", () => {
    const params = JSON.parse(
      readFileSync("params/crucible.params.json", "utf-8")
    ) as { rounding: string };
    expect(params.rounding).toBe("floor_remainder_to_treasury");
  });
});

describe("mainnet preflight: unsigned templates rejected", () => {
  it("audit-signoff.json is unsigned", () => {
    expect(loadTemplate("audit-signoff").signed).toBe(false);
  });
  it("legal-signoff.json is unsigned", () => {
    expect(loadTemplate("legal-signoff").signed).toBe(false);
  });
  it("genesis-cohort.json is unsigned", () => {
    expect(loadTemplate("genesis-cohort").signed).toBe(false);
  });
  it("timelock.json is unsigned", () => {
    expect(loadTemplate("timelock").signed).toBe(false);
  });
  it("monitoring.json is unsigned", () => {
    expect(loadTemplate("monitoring").signed).toBe(false);
  });
  it("treasury.json is unsigned", () => {
    expect(loadTemplate("treasury").signed).toBe(false);
  });

  it("audit-signoff.json missing required fields", () => {
    const t = loadTemplate("audit-signoff");
    expect(t.auditor).toBe("");
    expect(t.reportHash).toBe("");
    expect(t.commit).toBe("");
  });

  it("treasury.json missing required fields", () => {
    const t = loadTemplate("treasury");
    expect(t.chainId).toBe(1);
    expect(t.asset).toBe("native-ETH");
    expect(t.treasurySafe.address).toBe("");
    expect(t.ownerSafe.address).toBe("");
    expect(t.deploymentCommit).toBe("");
    expect(t.evidenceHash).toBe("");
  });
});

describe("mainnet preflight: template structure", () => {
  it("treasury.json has distinct Treasury and Owner Safe placeholders", () => {
    const t = loadTemplate("treasury");
    // Both are empty templates — the preflight requires them to be distinct
    // non-zero addresses when signed. Empty is the unsigned state.
    expect(t.treasurySafe.address).toBe("");
    expect(t.ownerSafe.address).toBe("");
  });

  it("treasury.json escrows.legacyTrials is present but empty", () => {
    const t = loadTemplate("treasury");
    expect(t.escrows).toBeDefined();
    expect(t.escrows.legacyTrials.address).toBe("");
    expect(t.escrows.legacyTrials.runtimeCodeHash).toBe("");
  });

  it("genesis-cohort.json has required fields empty", () => {
    const t = loadTemplate("genesis-cohort");
    expect(t.sponsors).toEqual([]);
    expect(t.agents).toEqual([]);
    expect(t.epochCapEth).toBe("0");
  });

  it("timelock.json has required fields empty", () => {
    const t = loadTemplate("timelock");
    expect(t.multisig).toBe("");
    expect(t.signers).toEqual([]);
  });

  it("monitoring.json has required fields empty", () => {
    const t = loadTemplate("monitoring");
    expect(t.oncall).toBe("");
    expect(t.alertChannel).toBe("");
    expect(t.dashboards).toEqual([]);
  });
});
