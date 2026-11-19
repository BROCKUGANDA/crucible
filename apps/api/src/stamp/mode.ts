/**
 * @file mode.ts — `STAMP_MODE` and the production preflight.
 *
 * The blueprint is emphatic that `STAMP_MODE=production` must not be inferred
 * from `NODE_ENV`, and that production must fail closed when a required value
 * is absent or differs from the signed manifest. So:
 *
 *   - The mode is its own variable, and an unknown value reads as `disabled`.
 *   - `production` is a *request*. It is granted only when a manifest file
 *     exists, parses, and compares clean against the live configuration.
 *   - A missing manifest is a refusal with a reason, never a default open.
 */

import { readFileSync } from "node:fs";
import {
  compareManifest,
  productionMayRun,
  type LiveConfiguration,
  type PreflightManifest,
} from "@crucible/stamp-core";

export type StampMode = "disabled" | "sandbox" | "manual_review" | "production";

const VALID: readonly StampMode[] = ["disabled", "sandbox", "manual_review", "production"];

export function resolveMode(raw: string | undefined = process.env.STAMP_MODE): StampMode {
  const value = (raw ?? "disabled").trim();
  return (VALID as readonly string[]).includes(value) ? (value as StampMode) : "disabled";
}

/**
 * The live configuration, read from the environment the process was started
 * with. Every name is the one the blueprint's manifest names.
 */
export function liveConfigurationFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): LiveConfiguration {
  const read = (key: string): string | null => {
    const value = env[key]?.trim();
    return value ? value : null;
  };
  return {
    issuerLegalEntityId: read("STAMP_ISSUER_LEGAL_ENTITY_ID"),
    issuerJurisdiction: read("STAMP_ISSUER_JURISDICTION"),
    legalAgreementSha256: read("STAMP_LEGAL_AGREEMENT_SHA256"),
    counselApprovalRef: read("STAMP_COUNSEL_APPROVAL_REF"),
    metaDaoProjectRef: read("STAMP_META_DAO_PROJECT_REF"),
    solanaCluster: read("STAMP_SOLANA_CLUSTER"),
    solanaGenesisHash: read("STAMP_SOLANA_GENESIS_HASH"),
    acceptedStablecoinMint: read("STAMP_ACCEPTABLE_STABLECOIN_MINT"),
    approvedWallet: read("STAMP_APPROVED_WALLET"),
    tokenMint: read("STAMP_TOKEN_MINT"),
    tokenProgramId: read("STAMP_TOKEN_PROGRAM_ID"),
    daoTreasuryAddress: read("STAMP_DAO_TREASURY_ADDRESS"),
    vestingMechanism: read("STAMP_VESTING_MECHANISM"),
    vestingAccountRef: read("STAMP_VESTING_ACCOUNT_REF"),
    ipAssignmentManifestSha256: read("STAMP_IP_ASSIGNMENT_MANIFEST_SHA256"),
    investorReserveBps: read("STAMP_INVESTOR_RESERVE_BPS"),
    teamAllocationBps: read("STAMP_TEAM_ALLOCATION_BPS"),
    totalNetworkTokens: read("STAMP_TOTAL_NETWORK_TOKENS"),
    approvals: null,
  };
}

export interface ProductionGate {
  /** True only when every manifest field matches the live configuration. */
  unlocked: boolean;
  reason: string | null;
  mismatches: { field: string; expected: string; actual: string }[];
  missing: string[];
}

const LOCKED_DEFAULT: ProductionGate = {
  unlocked: false,
  reason: "no STAMP preflight manifest has been loaded",
  mismatches: [],
  missing: [],
};

let cachedGate: ProductionGate | null = null;

/**
 * Evaluate the production gate.
 *
 * A manifest is only ever read from a path an operator named; the process does
 * not search for one. That keeps "there is a manifest somewhere" from being
 * mistaken for "this deployment has been approved".
 */
export function evaluateProductionGate(
  options: {
    manifestPath?: string | null;
    env?: NodeJS.ProcessEnv;
    readFile?: (path: string) => string;
  } = {},
): ProductionGate {
  const manifestPath = options.manifestPath ?? process.env.STAMP_MANIFEST_PATH ?? null;
  if (!manifestPath) return { ...LOCKED_DEFAULT };

  let raw: string;
  try {
    raw = (options.readFile ?? ((path: string) => readFileSync(path, "utf8")))(manifestPath);
  } catch (error) {
    return {
      unlocked: false,
      reason: `preflight manifest ${manifestPath} could not be read: ${(error as Error).message}`,
      mismatches: [],
      missing: [],
    };
  }

  let manifest: PreflightManifest;
  try {
    manifest = JSON.parse(raw) as PreflightManifest;
  } catch (error) {
    return {
      unlocked: false,
      reason: `preflight manifest ${manifestPath} is not valid JSON: ${(error as Error).message}`,
      mismatches: [],
      missing: [],
    };
  }
  if (!manifest.version) {
    return {
      unlocked: false,
      reason: `preflight manifest ${manifestPath} carries no version, so it is not reviewable`,
      mismatches: [],
      missing: [],
    };
  }

  const comparison = compareManifest(manifest, liveConfigurationFromEnv(options.env));
  const verdict = productionMayRun(comparison);
  return {
    unlocked: verdict.allowed,
    reason: verdict.reason,
    mismatches: comparison.mismatches,
    missing: comparison.missing,
  };
}

/** The gate for this process, evaluated once per distinct manifest path. */
export function productionGate(manifestPath?: string | null): ProductionGate {
  const path = manifestPath ?? process.env.STAMP_MANIFEST_PATH ?? null;
  if (cachedGate && path === (process.env.STAMP_MANIFEST_PATH ?? null)) return cachedGate;
  cachedGate = evaluateProductionGate({ manifestPath: path });
  return cachedGate;
}

export function __resetProductionGateForTests(): void {
  cachedGate = null;
}

/**
 * May this process perform an irreversible STAMP action?
 *
 * `sandbox` never may (no real funds, no legal effect). `manual_review` may not
 * either, and that is deliberate: a reviewer records evidence in manual review,
 * but payment acceptance and token delivery stay off until the manifest's
 * approvals exist. `production` may, when the gate is unlocked.
 */
export function irreversibleActionsAllowed(
  mode: StampMode,
  gate: ProductionGate = productionGate(),
): { allowed: boolean; code: string | null; reason: string | null } {
  if (mode === "disabled") {
    return { allowed: false, code: "stamp_disabled", reason: "STAMP is disabled on this host" };
  }
  if (mode === "sandbox") {
    return {
      allowed: false,
      code: "stamp_sandbox_only",
      reason: "sandbox records fixture observations only; no payment acceptance or delivery",
    };
  }
  if (mode === "manual_review") {
    return {
      allowed: false,
      code: "stamp_manual_review_only",
      reason: "manual review records evidence; irreversible actions require the production manifest",
    };
  }
  if (!gate.unlocked) {
    return {
      allowed: false,
      code: "stamp_production_blocked",
      reason: gate.reason ?? "the production preflight manifest does not match this host",
    };
  }
  return { allowed: true, code: null, reason: null };
}