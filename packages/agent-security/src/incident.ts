/**
 * @file incident.ts — Severity taxonomy, incident template, and escalation.
 *
 * Severity levels and escalation paths for operational incidents. Severity is
 * assigned by a human responder; it is never auto-inferred from metrics alone.
 *
 * In-memory store, consistent with ADR-0008. Migration-ready for PostgreSQL.
 */

const STATE_KEY = "__crucible_incident__";
const globalScope = globalThis as unknown as Record<string, unknown>;

type IncidentStore = {
  incidents: Map<string, Incident>;
  /** severity -> set of incident ids */
  bySeverity: Map<IncidentSeverity, Set<string>>;
  /** status -> set of incident ids */
  byStatus: Map<IncidentStatus, Set<string>>;
};

function getStore(): IncidentStore {
  let store = globalScope[STATE_KEY] as IncidentStore | undefined;
  if (!store) {
    store = {
      incidents: new Map(),
      bySeverity: new Map(),
      byStatus: new Map(),
    };
    globalScope[STATE_KEY] = store;
  }
  return store;
}

export type IncidentSeverity = "sev1" | "sev2" | "sev3" | "sev4";

export type IncidentStatus =
  | "open"
  | "investigating"
  | "mitigated"
  | "resolved"
  | "closed";

export interface SeverityDefinition {
  level: IncidentSeverity;
  description: string;
  responder: string;
  escalationPath: string[];
  maxResponseTimeMs: number;
}

/**
 * Severity taxonomy. Each level has a named responder, an escalation path,
 * and a maximum response time. These are operational targets, not SLAs.
 */
export const SEVERITY_TAXONOMY: Record<IncidentSeverity, SeverityDefinition> = {
  sev1: {
    level: "sev1",
    description:
      "Critical: customer-impacting outage, security breach, or financial risk.",
    responder: "platform-operator-oncall",
    escalationPath: [
      "platform-operator-oncall",
      "engineering-manager",
      "cto",
    ],
    maxResponseTimeMs: 15 * 60 * 1000, // 15 minutes
  },
  sev2: {
    level: "sev2",
    description:
      "Major: significant degradation, partial outage, or important feature broken.",
    responder: "engineering-oncall",
    escalationPath: ["engineering-oncall", "engineering-manager"],
    maxResponseTimeMs: 60 * 60 * 1000, // 1 hour
  },
  sev3: {
    level: "sev3",
    description:
      "Minor: limited impact, workaround available, or non-critical feature broken.",
    responder: "engineering-oncall",
    escalationPath: ["engineering-oncall"],
    maxResponseTimeMs: 4 * 60 * 60 * 1000, // 4 hours
  },
  sev4: {
    level: "sev4",
    description:
      "Low: cosmetic issue, documentation gap, or low-priority enhancement.",
    responder: "engineering-team",
    escalationPath: ["engineering-team"],
    maxResponseTimeMs: 24 * 60 * 60 * 1000, // 24 hours
  },
};

export interface Incident {
  id: string;
  title: string;
  description: string;
  severity: IncidentSeverity;
  status: IncidentStatus;
  responder: string;
  /** principal who created the incident */
  reportedBy: string;
  createdAt: number;
  updatedAt: number;
  resolvedAt?: number;
  /** escalation steps taken */
  escalationHistory: EscalationStep[];
  /** free-form metadata, no secrets */
  metadata: Record<string, unknown>;
}

export interface EscalationStep {
  at: number;
  from: string;
  to: string;
  reason: string;
}

export function newIncident(
  id: string,
  title: string,
  description: string,
  severity: IncidentSeverity,
  reportedBy: string,
): Incident {
  if (!id || !title || !description || !severity || !reportedBy) {
    throw new Error(
      "incident: id, title, description, severity and reportedBy are required",
    );
  }
  const def = SEVERITY_TAXONOMY[severity];
  const now = Date.now();
  return {
    id,
    title,
    description,
    severity,
    status: "open",
    responder: def.responder,
    reportedBy,
    createdAt: now,
    updatedAt: now,
    escalationHistory: [],
    metadata: {},
  };
}

export function createIncident(incident: Incident): void {
  const store = getStore();
  if (store.incidents.has(incident.id)) {
    throw new Error(`incident: incident already exists: ${incident.id}`);
  }
  store.incidents.set(incident.id, incident);
  store.bySeverity.get(incident.severity)?.add(incident.id) ??
    store.bySeverity.set(incident.severity, new Set([incident.id]));
  store.byStatus.get(incident.status)?.add(incident.id) ??
    store.byStatus.set(incident.status, new Set([incident.id]));
}

export function getIncident(id: string): Incident | null {
  return getStore().incidents.get(id) ?? null;
}

export function listIncidents(status?: IncidentStatus): Incident[] {
  const store = getStore();
  if (status) {
    const ids = store.byStatus.get(status);
    if (!ids) return [];
    return [...ids].map((id) => store.incidents.get(id)).filter(Boolean) as Incident[];
  }
  return [...store.incidents.values()];
}

export function listIncidentsBySeverity(severity: IncidentSeverity): Incident[] {
  const store = getStore();
  const ids = store.bySeverity.get(severity);
  if (!ids) return [];
  return [...ids].map((id) => store.incidents.get(id)).filter(Boolean) as Incident[];
}

export function updateIncidentStatus(
  id: string,
  status: IncidentStatus,
  actor: string,
): Incident | null {
  const store = getStore();
  const inc = store.incidents.get(id);
  if (!inc) return null;
  const previous = inc.status;
  inc.status = status;
  inc.updatedAt = Date.now();
  if (status === "resolved") inc.resolvedAt = Date.now();
  store.incidents.set(id, inc);
  // Move in byStatus index.
  store.byStatus.get(previous)?.delete(id);
  store.byStatus.get(status)?.add(id) ?? store.byStatus.set(status, new Set([id]));
  return inc;
}

export function escalate(
  id: string,
  to: string,
  reason: string,
  actor: string,
): Incident | null {
  const store = getStore();
  const inc = store.incidents.get(id);
  if (!inc) return null;
  const from = inc.responder;
  inc.responder = to;
  inc.updatedAt = Date.now();
  inc.escalationHistory.push({ at: Date.now(), from, to, reason });
  store.incidents.set(id, inc);
  return inc;
}

/** Reset store state (testing only). */
export function __resetIncidentStoreForTests(): void {
  const store = getStore();
  store.incidents.clear();
  store.bySeverity.clear();
  store.byStatus.clear();
}

/** TypeScript brand. */
export const __incidentBrand = Symbol.for("crucible.incident");