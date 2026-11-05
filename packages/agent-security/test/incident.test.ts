/**
 * @file incident.test.ts — Severity taxonomy and incident tests.
 */

import { describe, it, expect, beforeEach } from "vitest";
import {
  newIncident,
  createIncident,
  getIncident,
  listIncidents,
  listIncidentsBySeverity,
  updateIncidentStatus,
  escalate,
  SEVERITY_TAXONOMY,
  __resetIncidentStoreForTests,
} from "../src/incident.js";

beforeEach(() => {
  __resetIncidentStoreForTests();
});

describe("SEVERITY_TAXONOMY", () => {
  it("defines all four severity levels", () => {
    expect(Object.keys(SEVERITY_TAXONOMY)).toEqual([
      "sev1", "sev2", "sev3", "sev4",
    ]);
  });

  it("each level has responder, escalation path, and response time", () => {
    for (const def of Object.values(SEVERITY_TAXONOMY)) {
      expect(def.responder).toBeTruthy();
      expect(Array.isArray(def.escalationPath)).toBe(true);
      expect(def.escalationPath.length).toBeGreaterThan(0);
      expect(typeof def.maxResponseTimeMs).toBe("number");
      expect(def.maxResponseTimeMs).toBeGreaterThan(0);
    }
  });

  it("sev1 has the fastest response time", () => {
    expect(SEVERITY_TAXONOMY.sev1.maxResponseTimeMs).toBeLessThan(
      SEVERITY_TAXONOMY.sev2.maxResponseTimeMs,
    );
    expect(SEVERITY_TAXONOMY.sev2.maxResponseTimeMs).toBeLessThan(
      SEVERITY_TAXONOMY.sev3.maxResponseTimeMs,
    );
    expect(SEVERITY_TAXONOMY.sev3.maxResponseTimeMs).toBeLessThan(
      SEVERITY_TAXONOMY.sev4.maxResponseTimeMs,
    );
  });
});

describe("incidents", () => {
  it("creates, reads and lists", () => {
    const inc = newIncident(
      "inc-1",
      "API outage",
      "The API is returning 503s.",
      "sev1",
      "0xowner",
    );
    createIncident(inc);
    expect(getIncident("inc-1")).toEqual(inc);
    expect(listIncidents()).toHaveLength(1);
    expect(listIncidents("open")).toHaveLength(1);
    expect(listIncidents("closed")).toHaveLength(0);
  });

  it("filters by severity", () => {
    createIncident(newIncident("i1", "a", "a", "sev1", "0xowner"));
    createIncident(newIncident("i2", "b", "b", "sev3", "0xowner"));
    createIncident(newIncident("i3", "c", "c", "sev1", "0xowner"));
    expect(listIncidentsBySeverity("sev1")).toHaveLength(2);
    expect(listIncidentsBySeverity("sev3")).toHaveLength(1);
    expect(listIncidentsBySeverity("sev4")).toHaveLength(0);
  });

  it("rejects duplicate incident", () => {
    const inc = newIncident("inc-1", "a", "b", "sev1", "0xowner");
    createIncident(inc);
    expect(() => createIncident(inc)).toThrow();
  });

  it("rejects invalid incident", () => {
    expect(() => newIncident("", "a", "b", "sev1", "0xowner")).toThrow();
  });

  it("updates status and tracks resolution", () => {
    createIncident(newIncident("inc-1", "a", "b", "sev1", "0xowner"));
    const updated = updateIncidentStatus("inc-1", "resolved", "0xowner");
    expect(updated?.status).toBe("resolved");
    expect(updated?.resolvedAt).not.toBeNull();
    expect(listIncidents("open")).toHaveLength(0);
    expect(listIncidents("resolved")).toHaveLength(1);
    expect(updateIncidentStatus("nope", "closed", "0xowner")).toBeNull();
  });

  it("escalates and records history", () => {
    createIncident(newIncident("inc-1", "a", "b", "sev1", "0xowner"));
    const escalated = escalate(
      "inc-1",
      "engineering-manager",
      "no response from oncall",
      "0xowner",
    );
    expect(escalated?.responder).toBe("engineering-manager");
    expect(escalated?.escalationHistory).toHaveLength(1);
    expect(escalated?.escalationHistory[0].from).toBe(
      SEVERITY_TAXONOMY.sev1.responder,
    );
    expect(escalate("nope", "x", "y", "0xowner")).toBeNull();
  });
});
