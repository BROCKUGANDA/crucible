import type { ActionRequest, Decision, Permission } from "./types.js";

import { scanUntrusted } from "./injection.js";

/**
 * Input sanitisation and output validation.
 *
 * The asymmetry is deliberate. Inputs are attacker-controlled (a sponsor's spec, a
 * skeptic's proof), so they are scanned and quarantined. Outputs are
 * agent-controlled, so they are *validated against a schema* — an agent that returns
 * prose where a run artifact belongs must be rejected, not coerced.
 */

export interface ValidationIssue {
  path: string;
  message: string;
  severity: "error" | "warning";
}

export interface ValidationResult<T> {
  valid: boolean;
  value?: T;
  issues: ValidationIssue[];
}

type SchemaType =
  | "string"
  | "number"
  | "integer"
  | "boolean"
  | "array"
  | "object"
  | "address"
  | "hex"
  | "cid"
  | "timestamp"
  | "unknown";

export interface FieldSchema {
  type: SchemaType;
  required?: boolean;
  min?: number;
  max?: number;
  minLength?: number;
  maxLength?: number;
  pattern?: RegExp;
  items?: FieldSchema;
  properties?: Record<string, FieldSchema>;
  /** reject values matching an injection pattern, even inside a valid type */
  rejectInjection?: boolean;
}

/**
 * Sanitise untrusted input: normalise, cap size, strip control characters and any
 * attempt to break out of a fenced region.
 */
export function sanitizeInput(input: string, args: { maxLength?: number } = {}): string {
  const max = args.maxLength ?? 100_000;
  let s = input.slice(0, max);

  // strip C0/C1 control characters except tab and newline
  s = s.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/g, "");
  // normalise line endings so span offsets are stable across platforms
  s = s.replace(/\r\n?/g, "\n");
  // strip the fence terminators an injected payload would use
  s = s.replace(/```+/g, "`");
  return s;
}

/** Validate an object against a schema. Errors block; warnings do not. */
export function validateOutput<T>(
  value: unknown,
  schema: FieldSchema,
  path = "$",
): ValidationResult<T> {
  const issues: ValidationIssue[] = [];
  check(value, schema, path, issues);

  const hasError = issues.some((i) => i.severity === "error");
  return {
    valid: !hasError,
    ...(hasError ? {} : { value: value as T }),
    issues,
  };
}

function check(v: unknown, s: FieldSchema, path: string, issues: ValidationIssue[]): void {
  if (v === undefined || v === null) {
    if (s.required) issues.push({ path, message: "required field is missing", severity: "error" });
    return;
  }

  if (typeof v === "string" && s.rejectInjection) {
    const scan = scanUntrusted(v);
    if (scan.action === "reject") {
      issues.push({
        path,
        message: `output contains an injection pattern: ${scan.findings[0]?.kind}`,
        severity: "error",
      });
      return;
    }
  }

  switch (s.type) {
    case "string": {
      if (typeof v !== "string") return err(issues, path, `expected string, got ${typeof v}`);
      if (s.minLength !== undefined && v.length < s.minLength)
        err(issues, path, `shorter than ${s.minLength}`);
      if (s.maxLength !== undefined && v.length > s.maxLength)
        err(issues, path, `longer than ${s.maxLength}`);
      if (s.pattern && !s.pattern.test(v)) err(issues, path, "does not match the required pattern");
      return;
    }
    case "integer":
    case "number": {
      if (typeof v !== "number" || Number.isNaN(v))
        return err(issues, path, `expected ${s.type}, got ${typeof v}`);
      if (!Number.isFinite(v)) return err(issues, path, "value is not finite");
      if (s.type === "integer" && !Number.isInteger(v))
        return err(issues, path, "expected an integer");
      if (s.min !== undefined && v < s.min) err(issues, path, `below minimum ${s.min}`);
      if (s.max !== undefined && v > s.max) err(issues, path, `above maximum ${s.max}`);
      return;
    }
    case "boolean": {
      if (typeof v !== "boolean") err(issues, path, "expected boolean");
      return;
    }
    case "address": {
      if (typeof v !== "string" || !/^0x[a-fA-F0-9]{40}$/.test(v))
        return err(issues, path, "expected a 20-byte hex address");
      return;
    }
    case "hex": {
      if (typeof v !== "string" || !/^0x[0-9a-fA-F]+$/.test(v))
        return err(issues, path, "expected a hex string");
      if (s.maxLength !== undefined && v.length > s.maxLength) err(issues, path, "hex too long");
      return;
    }
    case "cid": {
      if (typeof v !== "string")
        return err(issues, path, `expected string, got ${typeof v}`);
      // CIDv0 is 46 chars, CIDv1 is 59. The original spec's regex said 57, which
      // rejected every real CIDv1 — see the README.
      if (!/^Qm[1-9A-HJ-NP-Za-km-z]{44}$/.test(v) && !/^b[a-z2-7]{58}$/.test(v))
        return err(issues, path, "not a valid IPFS CID");
      return;
    }
    case "timestamp": {
      if (typeof v !== "number" || !Number.isFinite(v))
        return err(issues, path, "expected a numeric timestamp");
      return;
    }
    case "array": {
      if (!Array.isArray(v)) return err(issues, path, "expected an array");
      if (s.min !== undefined && v.length < s.min) err(issues, path, `fewer than ${s.min} items`);
      if (s.max !== undefined && v.length > s.max) err(issues, path, `more than ${s.max} items`);
      if (s.items) v.forEach((item, i) => check(item, s.items!, `${path}[${i}]`, issues));
      return;
    }
    case "object": {
      if (typeof v !== "object" || Array.isArray(v)) return err(issues, path, "expected an object");
      if (s.properties) {
        for (const [k, sub] of Object.entries(s.properties)) {
          check((v as Record<string, unknown>)[k], sub, `${path}.${k}`, issues);
        }
      }
      return;
    }
    case "unknown":
      return;
  }
}

function err(issues: ValidationIssue[], path: string, message: string): void {
  issues.push({ path, message, severity: "error" });
}

/**
 * An agent may not widen its own authority. If the output claims capabilities, budget
 * or targets the input never granted, the claim is refused.
 */
export function checkAuthorityClaims(args: {
  claimed: { scopes?: Permission[]; maxValueWei?: bigint; targets?: string[] };
  granted: { scopes: readonly Permission[]; maxValueWei?: bigint; targets: readonly string[] };
}): Decision {
  const held = new Set(args.granted.scopes);
  const overreach = (args.claimed.scopes ?? []).filter((s) => !held.has(s));
  if (overreach.length > 0) {
    return {
      allow: false,
      reason: `output claims scope(s) never granted: ${overreach.join(", ")}`,
      code: "action-scope-exceeded",
    };
  }
  if (
    args.claimed.maxValueWei !== undefined &&
    args.granted.maxValueWei !== undefined &&
    args.claimed.maxValueWei > BigInt(args.granted.maxValueWei)
  ) {
    return {
      allow: false,
      reason: "output claims a larger value than the delegation permits",
      code: "action-scope-exceeded",
    };
  }
  for (const t of args.claimed.targets ?? []) {
    if (!args.granted.targets.some((p) => t.startsWith(p))) {
      return {
        allow: false,
        reason: `output claims target "${t}" outside the granted targets`,
        code: "action-scope-exceeded",
      };
    }
  }
  return { allow: true, reason: "no authority overreach" };
}

/** Agent-to-agent authentication: verify the caller is who it claims to be. */
export interface AgentEnvelope {
  from: string;
  to: string;
  /** nonce, single-use within `expiresAt` */
  nonce: string;
  issuedAt: number;
  expiresAt: number;
  /** HMAC over the canonical body */
  mac: string;
  body: Record<string, unknown>;
}

export class AgentChannel {
  private readonly seenNonces = new Set<string>();

  constructor(
    private readonly sharedSecret: string,
    private readonly verifyMac: (mac: string, payload: string, secret: string) => boolean,
  ) {}

  seal(args: {
    from: string;
    to: string;
    body: Record<string, unknown>;
    ttlMs?: number;
    nonce?: string;
  }): AgentEnvelope {
    const nonce = args.nonce ?? Math.random().toString(36).slice(2) + Date.now().toString(36);
    const issuedAt = Date.now();
    const expiresAt = issuedAt + (args.ttlMs ?? 60_000);
    const body = { ...args.body, from: args.from, to: args.to, nonce, issuedAt, expiresAt };
    return {
      from: args.from,
      to: args.to,
      nonce,
      issuedAt,
      expiresAt,
      mac: this.verifyMac("", canonical(body), this.sharedSecret) ? "" : computeMac(canonical(body), this.sharedSecret),
      body,
    };
  }

  open(envelope: AgentEnvelope, expectedRecipient: string, now = Date.now()): Decision {
    if (envelope.to !== expectedRecipient) {
      return { allow: false, reason: "envelope addressed to a different agent", code: "trust-chain-broken" };
    }
    if (now > envelope.expiresAt) {
      return { allow: false, reason: "envelope expired", code: "expired" };
    }
    if (this.seenNonces.has(envelope.nonce)) {
      return { allow: false, reason: "envelope nonce replayed", code: "replayed-nonce" };
    }
    const expected = computeMac(canonical(envelope.body), this.sharedSecret);
    if (envelope.mac !== expected) {
      return { allow: false, reason: "envelope MAC mismatch", code: "trust-chain-broken" };
    }
    this.seenNonces.add(envelope.nonce);
    return { allow: true, reason: "envelope authentic" };
  }
}

function canonical(body: Record<string, unknown>): string {
  return JSON.stringify(Object.fromEntries(Object.entries(body).sort(([a], [b]) => (a < b ? -1 : 1))));
}

/**
 * MAC computation. Uses Node's HMAC when available; the injection into a function
 * keeps the channel testable without assuming a runtime.
 */
function computeMac(payload: string, secret: string): string {
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { createHmac } = require("node:crypto") as typeof import("node:crypto");
    return createHmac("sha256", secret).update(payload).digest("hex");
  } catch {
    // deterministic fallback so the class works in a non-Node runtime
    let h1 = 0x811c9dc5;
    for (let i = 0; i < payload.length; i++) {
      h1 ^= payload.charCodeAt(i) + secret.charCodeAt(i % secret.length);
      h1 = Math.imul(h1, 0x01000193) >>> 0;
    }
    return h1.toString(16).padStart(8, "0").repeat(8);
  }
}
