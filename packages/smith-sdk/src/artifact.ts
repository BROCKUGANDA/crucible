import type { RunArtifact, TestResult } from "./types.js";
import { RUN_ARTIFACT_SCHEMA_VERSION } from "./types.js";

/** A test result as a suite runner reports it, before normalisation. */
export interface RawTestResult {
  name: string;
  status: "pass" | "fail" | "skip" | "PASS" | "FAIL" | "SKIP" | string;
  durationMs?: number;
  duration?: number | string;
  message?: string;
  output?: string;
}

export interface ForgeTestJson {
  suite?: string;
  tests?: RawTestResult[];
  [k: string]: unknown;
}

/**
 * Parse `forge test --json` output into the artifact's testResults.
 *
 * forge's JSON shape has drifted across releases (v1 nests under `test_results`,
 * later versions flatten), so this accepts several shapes rather than one. An
 * unrecognised shape is an error, not a silently empty suite — an empty
 * testResults would pass validateArtifact's minItems check only by accident and
 * would hand a skeptic an empty claim.
 */
export function parseForgeTests(json: string): TestResult[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    throw new Error("forge test --json returned output that is not JSON");
  }
  return normalizeForgeTests(parsed);
}

export function normalizeForgeTests(parsed: unknown): TestResult[] {
  const raw = extractTestArray(parsed);
  if (!raw) {
    throw new Error(
      "unrecognised forge test JSON shape; expected a `tests` array or `test_results` object",
    );
  }
  if (raw.length === 0) {
    throw new Error("forge reported zero tests; refusing to build an empty artifact");
  }
  return raw.map((t) => toTestResult(t));
}

function extractTestArray(parsed: unknown): RawTestResult[] | null {
  if (Array.isArray(parsed)) return parsed as RawTestResult[];
  if (parsed && typeof parsed === "object") {
    const o = parsed as Record<string, unknown>;
    if (Array.isArray(o.tests)) return o.tests as RawTestResult[];
    const tr = o.test_results;
    if (tr && typeof tr === "object") {
      // v1: { suite, test_results: { "testName()": { ... } } }
      const entries = Object.entries(tr as Record<string, unknown>);
      const mapped = entries.map(([name, v]) => {
        if (v && typeof v === "object") {
          return { name, ...(v as Record<string, unknown>) } as RawTestResult;
        }
        return { name, status: String(v) } as RawTestResult;
      });
      return mapped;
    }
  }
  return null;
}

function toTestResult(t: RawTestResult): TestResult {
  const name = t.name ?? "unnamed";
  const status = normalizeStatus(t.status);
  const durationMs = parseDuration(t);
  const out: TestResult = { name, status, durationMs };
  if (t.message) out.message = truncate(t.message, 2000);
  else if (t.output) out.message = truncate(t.output, 2000);
  return out;
}

function normalizeStatus(raw: string): TestResult["status"] {
  const s = String(raw).toLowerCase();
  if (s === "pass" || s === "passed" || s === "ok" || s === "success") return "pass";
  if (s === "fail" || s === "failed" || s === "failure") return "fail";
  if (s === "skip" || s === "skipped") return "skip";
  throw new Error(`unrecognised test status "${raw}"`);
}

function parseDuration(t: RawTestResult): number {
  if (typeof t.durationMs === "number" && Number.isFinite(t.durationMs)) {
    return Math.max(0, Math.floor(t.durationMs));
  }
  if (typeof t.duration === "number") return Math.max(0, Math.floor(t.duration));
  if (typeof t.duration === "string") {
    const parsed = Number(t.duration.replace(/[^0-9.]/g, ""));
    if (Number.isFinite(parsed)) return Math.max(0, Math.floor(parsed));
  }
  return 0;
}

function truncate(s: string, n: number): string {
  return s.length <= n ? s : `${s.slice(0, n - 1)}…`;
}

/** Summarise a suite for the operator console, e.g. "24/24 green". */
export function summarise(results: TestResult[]): {
  total: number;
  passed: number;
  failed: number;
  skipped: number;
  green: boolean;
  label: string;
} {
  const total = results.length;
  const passed = results.filter((r) => r.status === "pass").length;
  const failed = results.filter((r) => r.status === "fail").length;
  const skipped = results.filter((r) => r.status === "skip").length;
  return {
    total,
    passed,
    failed,
    skipped,
    green: failed === 0 && passed > 0,
    label: `${passed}/${total} green`,
  };
}

export interface BuildArtifactArgs {
  trialId: number;
  agentId: number;
  specCID: string;
  testsCID: string;
  repoCID: string;
  commitSHA: string;
  suiteCommand: string;
  testResults: TestResult[];
  logsCID: string;
  model: string;
  startedAt: number;
  finishedAt: number;
  runnerAddress: `0x${string}`;
  chainId: number;
  verifyingContract: `0x${string}`;
}

/**
 * Assemble the canonical artifact. durationMs is derived, never passed in —
 * a mismatch between it and finishedAt-startedAt is one of the things a skeptic
 * checks, so the SDK does not leave it to the caller to get right.
 */
export function buildArtifact(args: BuildArtifactArgs): RunArtifact {
  return {
    schemaVersion: RUN_ARTIFACT_SCHEMA_VERSION,
    trialId: args.trialId,
    agentId: args.agentId,
    specCID: args.specCID,
    testsCID: args.testsCID,
    repoCID: args.repoCID,
    commitSHA: args.commitSHA,
    suiteCommand: args.suiteCommand,
    testResults: args.testResults,
    logsCID: args.logsCID,
    durationMs: args.finishedAt - args.startedAt,
    model: args.model,
    startedAt: args.startedAt,
    finishedAt: args.finishedAt,
    runnerAddress: args.runnerAddress,
    chainId: args.chainId,
    verifyingContract: args.verifyingContract,
  };
}
