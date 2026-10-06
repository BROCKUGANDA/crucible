/**
 * Failure taxonomy. Every failure maps to a forge-status and an operator
 * notification. The rule from the PRD is that nothing crashes the runner and
 * nothing partially submits: an all-or-nothing artifact or an explicit failure.
 */

export type ForgeStatus =
  | "idle"
  | "quenching-spec"
  | "planning"
  | "forging"
  | "suite-running"
  | "green"
  | "red"
  | "exhausted"
  | "signed"
  | "submitted"
  | "failed";

export type FailureKind =
  | "spec-unfetchable"
  | "suite-fails-budget"
  | "sandbox-oom"
  | "sandbox-unavailable"
  | "sandbox-timeout"
  | "rpc-error"
  | "deadline-exceeded"
  | "bond-over-cap"
  | "agent-threw"
  | "artifact-invalid";

export class ForgeFailure extends Error {
  constructor(
    readonly kind: FailureKind,
    message: string,
    override readonly cause?: unknown,
  ) {
    super(message);
    this.name = "ForgeFailure";
  }
}

/** Operator-facing copy. Matches the /forge failure rows in the copy deck. */
export const FAILURE_COPY: Record<FailureKind, string> = {
  "spec-unfetchable": "Couldn't pull the spec from IPFS. Check the pin or retry.",
  "suite-fails-budget":
    "Out of iterations with tests still red. Restrike or walk away.",
  "sandbox-oom":
    "The sandbox melted — run exceeded memory. Shrink the workload.",
  "sandbox-unavailable":
    "Docker isn't available, so this run can't be sealed. Start Docker and retry.",
  "sandbox-timeout": "The run blew its wall-clock budget. Trim the workload.",
  "rpc-error": "Lost the RPC mid-run. Reconnecting…",
  "deadline-exceeded": "The trial's deadline passed before the work landed.",
  "bond-over-cap":
    "This trial's bond exceeds your risk cap. Raise it in Settings if you're sure.",
  "agent-threw": "The agent crashed mid-forge. Nothing was submitted.",
  "artifact-invalid": "The run artifact failed validation. Nothing was submitted.",
};

export interface StatusEvent {
  status: ForgeStatus;
  /** mono label for the operator console, e.g. "iter 3/8 — 12 red" */
  label: string;
  iteration?: number;
  maxIterations?: number;
  passed?: number;
  failed?: number;
  at: number;
}

/** Console lines from the copy deck, in the forge voice. */
export function suiteLine(
  iteration: number,
  max: number,
  passed: number,
  failed: number,
): string {
  if (failed === 0) return `✓ ${passed}/${passed + failed} green — signing artifact`;
  return `iter ${iteration}/${max} — ${failed} red`;
}

export function classify(error: unknown): ForgeFailure {
  if (error instanceof ForgeFailure) return error;
  const e = error as { name?: string; message?: string };
  switch (e?.name) {
    case "SandboxOOM":
      return new ForgeFailure("sandbox-oom", FAILURE_COPY["sandbox-oom"], error);
    case "SandboxTimeout":
      return new ForgeFailure("sandbox-timeout", FAILURE_COPY["sandbox-timeout"], error);
    case "SandboxUnavailable":
      return new ForgeFailure(
        "sandbox-unavailable",
        FAILURE_COPY["sandbox-unavailable"],
        error,
      );
    case "RiskCapExceeded":
      return new ForgeFailure("bond-over-cap", FAILURE_COPY["bond-over-cap"], error);
    case "RunArtifactError":
      return new ForgeFailure(
        "artifact-invalid",
        FAILURE_COPY["artifact-invalid"],
        error,
      );
    default:
      return new ForgeFailure(
        "agent-threw",
        e?.message ?? FAILURE_COPY["agent-threw"],
        error,
      );
  }
}

/** Status sink. The Forge console renders these; Warden logs them for alerts. */
export type StatusSink = (event: StatusEvent) => void;

export function consoleSink(write: (s: string) => void = (s) => process.stdout.write(s)): StatusSink {
  return (event) => {
    const prefix = event.status === "green" || event.status === "signed" ? "✓" : "▸";
    write(`${prefix} ${event.label}\n`);
  };
}

export function memorySink(): { sink: StatusSink; events: StatusEvent[] } {
  const events: StatusEvent[] = [];
  return { sink: (e) => events.push(e), events };
}
