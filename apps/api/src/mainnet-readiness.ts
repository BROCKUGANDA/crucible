/**
 * Server-side mainnet readiness evaluator.
 *
 * Per the directive, production financial operations stay disabled unless EVERY
 * required gate passes. A gate that is unknown or failed keeps mainnet disabled.
 * No fabricated deployment records: a gate is either verified (true), failed
 * (false), or unknown (null/undefined) — and unknown is treated as not-ready.
 *
 * This module is pure logic so it can be unit-tested without a database or chain.
 * Wiring to real inputs (deployment manifest, bytecode, Safe config, etc.) lives
 * in the route layer and is out of scope here.
 */

export type GateValue = boolean | null | undefined;

export interface MainnetGates {
  chainIdCorrect?: GateValue;
  deploymentManifestSigned?: GateValue;
  contractAddressesVerified?: GateValue;
  contractBytecodeVerified?: GateValue;
  independentAuditSignOff?: GateValue;
  treasurySafeConfigured?: GateValue;
  hardwareSignersPresent?: GateValue;
  governanceTimelock?: GateValue;
  durableDatabase?: GateValue;
  objectStorageDurable?: GateValue;
  backupRestoreDrill?: GateValue;
  monitoringAndOnCall?: GateValue;
  sponsorshipLimits?: GateValue;
  emergencyPauseControls?: GateValue;
  legalAndOperationalApproval?: GateValue;
  mainnetPreflightTests?: GateValue;
}

export const REQUIRED_GATES: readonly (keyof MainnetGates)[] = [
  "chainIdCorrect",
  "deploymentManifestSigned",
  "contractAddressesVerified",
  "contractBytecodeVerified",
  "independentAuditSignOff",
  "treasurySafeConfigured",
  "hardwareSignersPresent",
  "governanceTimelock",
  "durableDatabase",
  "objectStorageDurable",
  "backupRestoreDrill",
  "monitoringAndOnCall",
  "sponsorshipLimits",
  "emergencyPauseControls",
  "legalAndOperationalApproval",
  "mainnetPreflightTests",
];

export interface MainnetReadinessResult {
  ready: boolean;
  passed: string[];
  failed: string[];
  unknown: string[];
}

export function evaluateMainnetReadiness(gates: MainnetGates): MainnetReadinessResult {
  const passed: string[] = [];
  const failed: string[] = [];
  const unknown: string[] = [];
  for (const gate of REQUIRED_GATES) {
    const v = gates[gate];
    if (v === true) passed.push(gate);
    else if (v === false) failed.push(gate);
    else unknown.push(gate);
  }
  const ready = failed.length === 0 && unknown.length === 0 && passed.length === REQUIRED_GATES.length;
  return { ready, passed, failed, unknown };
}
