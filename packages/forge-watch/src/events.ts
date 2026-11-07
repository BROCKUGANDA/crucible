/**
 * @file events.ts — Canonical Forge Watch telemetry event envelope.
 *
 * Every event the monitoring system observes is represented by exactly one
 * canonical envelope, generated at the trusted execution boundary. The monitor
 * and the agent consume the *same* representation — there is no separately
 * reconstructed copy, because two versions of an event are how an agent hides
 * what it actually did from what a monitor saw.
 *
 * Schema is versioned and strictly validated: a malformed event is a
 * telemetry-integrity finding, not a best-effort parse. Only fields applicable
 * to an event kind are populated; missing data remains explicitly `undefined`,
 * never guessed.
 *
 * Sequence numbers are monotonic per run with no silent gaps. A gap is a
 * telemetry-integrity finding.
 */

import { z } from "zod";

/** Bumped whenever the envelope shape or field semantics change. */
export const FORGE_WATCH_SCHEMA_VERSION = 1;

/** Every event kind Forge Watch accounts for. */
export const ForgeWatchEventType = {
  // Provider model requests and responses
  providerRequest: "provider.request",
  providerResponse: "provider.response",
  providerError: "provider.error",
  // Agent turn lifecycle
  agentTurnStart: "agent.turn.start",
  agentTurnComplete: "agent.turn.complete",
  agentTurnError: "agent.turn.error",
  // Tool-call lifecycle
  toolCallCreate: "tool.call.create",
  toolCallAuthorize: "tool.call.authorize",
  toolCallDeny: "tool.call.deny",
  toolCallExecute: "tool.call.execute",
  toolCallOutput: "tool.call.output",
  // Filesystem / process / network
  filesystemAccess: "filesystem.access",
  processCreate: "process.create",
  processChildCreate: "process.child.create",
  processTerminate: "process.terminate",
  networkConnect: "network.connect",
  networkDns: "network.dns",
  // Egress and gateway
  egressDecision: "egress.decision",
  apiGatewayActivity: "api.gateway.activity",
  // Credentials
  credentialAccess: "credential.access",
  credentialRevoke: "credential.revoke",
  // Containers
  containerCreate: "container.create",
  containerDestroy: "container.destroy",
  containerResource: "container.resource",
  // Delegation / child runs
  agentDelegation: "agent.delegation",
  childRunCreate: "child.run.create",
  // Context compaction / summarisation
  contextCompaction: "context.compaction",
  contextSummary: "context.summary",
  // Worker lifecycle
  workerRetry: "worker.retry",
  workerRecovery: "worker.recovery",
  // Grader / tests
  graderExecution: "grader.execution",
  testModification: "test.modification",
  // Monitoring itself
  monitorDispatch: "monitor.dispatch",
  monitorComplete: "monitor.complete",
  monitorError: "monitor.error",
  // Session / kill switch
  sessionInterrupt: "session.interrupt",
  killSwitchInvoke: "kill.switch.invoke",
} as const;

export type ForgeWatchEventType =
  (typeof ForgeWatchEventType)[keyof typeof ForgeWatchEventType];

/** Authorization outcomes the gate records. */
export type AuthorizationDecision = "allowed" | "denied" | "pending";

/**
 * The canonical envelope. Core identity fields are required; everything else is
 * optional and only present when the event kind makes it applicable.
 */
export const ForgeWatchEventSchema = z.object({
  eventId: z.string().uuid(),
  schemaVersion: z.literal(FORGE_WATCH_SCHEMA_VERSION),
  timestamp: z.number().int().nonnegative(),
  runId: z.string().min(1),
  trialId: z.string().min(1),
  agentId: z.string().min(1),
  tenantId: z.string().min(1),
  parentRunId: z.string().min(1).optional(),
  sequence: z.number().int().nonnegative(),
  eventType: z.nativeEnum(ForgeWatchEventType),
  source: z.string().min(1),
  providerId: z.string().min(1).optional(),
  modelId: z.string().min(1).optional(),
  toolId: z.string().min(1).optional(),
  permission: z.string().min(1).optional(),
  authorizationDecision: z
    .enum(["allowed", "denied", "pending"])
    .optional(),
  environmentId: z.string().min(1).optional(),
  payloadDigest: z.string().min(1).optional(),
  policyDigest: z.string().min(1).optional(),
  contextDigest: z.string().min(1).optional(),
  correlationId: z.string().min(1).optional(),
});

export type ForgeWatchEvent = z.infer<typeof ForgeWatchEventSchema>;

/**
 * Validate and coerce nothing: returns the parsed envelope or throws on the
 * first malformed field. A gate that silently cooks a bad event into a valid
 * one is a gate that hides tampering.
 */
export function parseForgeWatchEvent(input: unknown): ForgeWatchEvent {
  return ForgeWatchEventSchema.parse(input);
}

/** Safe parse that never throws; the caller decides what a bad event means. */
export function safeParseForgeWatchEvent(
  input: unknown,
): { success: true; data: ForgeWatchEvent } | { success: false; error: z.ZodError } {
  const result = ForgeWatchEventSchema.safeParse(input);
  if (result.success) return { success: true, data: result.data };
  return { success: false, error: result.error };
}

/** Fields required on every envelope, regardless of kind. */
export interface ForgeWatchEventBase {
  runId: string;
  trialId: string;
  agentId: string;
  tenantId: string;
  eventType: ForgeWatchEventType;
  source: string;
}

/**
 * Build a partially-filled envelope without validating yet. The caller must
 * call `parseForgeWatchEvent` (or `safeParseForgeWatchEvent`) before the
 * envelope crosses into the collector. The base identity fields are always
 * present on the result.
 */
export function forgeWatchEvent(
  base: ForgeWatchEventBase,
  overrides: Partial<
    Omit<ForgeWatchEvent, keyof ForgeWatchEventBase | "schemaVersion"> & {
      sequence?: number;
      timestamp?: number;
      eventId?: string;
    }
  >,
): ForgeWatchEventBase & Partial<Omit<ForgeWatchEvent, keyof ForgeWatchEventBase>> {
  return {
    schemaVersion: FORGE_WATCH_SCHEMA_VERSION,
    timestamp: overrides.timestamp ?? Date.now(),
    eventId: overrides.eventId ?? crypto.randomUUID(),
    sequence: overrides.sequence ?? 0,
    ...base,
    ...overrides,
  };
}
