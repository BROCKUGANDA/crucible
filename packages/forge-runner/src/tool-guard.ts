import {
  Toolbox,
  leastPrivilegeScopes,
  type Permission,
  type Principal,
  type ToolTraceEntry,
} from "@crucible/agent-security";
import { MODEL_ACTION, MODEL_PERMISSION, type ForgedAgentOptions, type LlmClient } from "./agent.js";

/**
 * The tool-policy layer, wired to the one privileged call the work loop actually makes.
 *
 * `@crucible/agent-security` has carried a complete allow-list engine for some time —
 * deny-by-default registration, per-principal grants, scope requirements, a per-session
 * ceiling, and a trace that records denials hardest of all — and nothing on a runtime path
 * ever asked it anything. `defaultToolPolicies()` even registers `read_file`, `write_file`
 * and `run_suite`: the same three names `AgentCapabilities.tools` defaults to. The missing
 * piece was never a control, it was a wire, and a control no caller routes through is
 * decoration however thoroughly it is tested.
 *
 * The model call goes *through* the toolbox rather than being merely permitted by it, so
 * the ceiling is real: an agent that loops past `maxCallsPerSession` is refused by the same
 * object that holds its only route to the model. Scopes are not supplied by the caller as a
 * list of strings it chose — they are derived from the principal's role by
 * `leastPrivilegeScopes`, so a principal whose role may not hold `trial:run` gets an empty
 * set and every call is refused, without this file having to know the role matrix.
 */

/** The tool name the model call is registered under. */
export const MODEL_TOOL = MODEL_ACTION;

/**
 * A model call costs tokens and nothing else, and it is reversible in the sense that no
 * on-chain state moves until the artifact is signed. It sits between `write_file` (5) and
 * `run_suite` (8) in `defaultToolPolicies()`, so it takes the lower of the two.
 */
const MODEL_RISK_WEIGHT = 5;

export interface ModelGuard {
  /** hand this to `createForgedAgent` as `guard` */
  guard: NonNullable<ForgedAgentOptions["guard"]>;
  /** every attempt in this session, oldest first, denials included and inputs never */
  trace(): readonly ToolTraceEntry[];
  /** the scopes this principal was actually allowed to hold */
  readonly scopes: readonly Permission[];
}

export interface ModelGuardOptions {
  client: LlmClient;
  /** temperature for the call the guard performs */
  temperature?: number;
  /** hard ceiling on model calls in one session. Omit only for a run with no budget. */
  maxCallsPerSession?: number;
  principal: Principal;
  sessionId: string;
  /** what the caller asks to hold; the role matrix decides what it gets */
  requestedScopes?: readonly Permission[];
}

export function createModelGuard(opts: ModelGuardOptions): ModelGuard {
  const scopes = leastPrivilegeScopes(opts.principal.role, [
    ...(opts.requestedScopes ?? [MODEL_PERMISSION]),
  ]);

  const toolbox = new Toolbox({
    invoke: async (name, input) => {
      // One capability, so an unknown name is a wiring fault and not a fallback. Completing
      // anyway would let a second registered tool reach the model without its own policy.
      if (name !== MODEL_TOOL) {
        throw new Error(`this toolbox holds one tool; "${name}" is not it`);
      }
      return opts.client.complete({
        system: String(input.system ?? ""),
        prompt: String(input.prompt ?? ""),
        ...(opts.temperature !== undefined ? { temperature: opts.temperature } : {}),
      });
    },
  });

  toolbox.register({
    name: MODEL_TOOL,
    requiredScopes: [MODEL_PERMISSION],
    ...(opts.maxCallsPerSession !== undefined
      ? { maxCallsPerSession: opts.maxCallsPerSession }
      : {}),
    riskWeight: MODEL_RISK_WEIGHT,
  });
  toolbox.grant(opts.principal.id, MODEL_TOOL);

  return {
    scopes,
    guard: {
      async call({ action, input }) {
        // `permission` from the call site is deliberately not forwarded: the registered
        // policy owns the scope requirement, so a caller cannot widen it by asking for less.
        const result = await toolbox.call({
          principal: opts.principal,
          credentialScopes: scopes,
          tool: action,
          input,
          sessionId: opts.sessionId,
        });
        return result.ok
          ? { ok: true as const, output: result.output }
          : { ok: false as const, reason: result.reason };
      },
    },
    trace: () => toolbox.traceFor(opts.sessionId),
  };
}
