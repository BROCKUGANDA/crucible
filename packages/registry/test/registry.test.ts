import { beforeEach, describe, expect, it } from "vitest";
import {
  createRegistryEntry,
  entryIdFor,
  verifyEntryId,
  type OneRegistry,
} from "../src/index.js";
import { OneRegistry as OneRegistryClass } from "../src/registry.js";

function agentManifest(name: string): Parameters<typeof createRegistryEntry>[0] {
  return {
    kind: "agent",
    name,
    description: `Test agent ${name}`,
    license: "MIT",
    provenance: "test",
    createdAt: Date.now(),
    domains: ["research"],
    model: "claude-sonnet-4-5",
    tools: ["read", "write"],
    limits: { maxCalls: 100 },
  };
}

function suiteManifest(
  name: string,
  datasetId: string = "ds-test",
): Parameters<typeof createRegistryEntry>[0] {
  return {
    kind: "suite",
    name,
    description: `Test suite ${name}`,
    license: "MIT",
    provenance: "test",
    createdAt: Date.now(),
    datasetId,
    split: "train",
    probeCount: 10,
  };
}

describe("one-registry consolidation (gate 753)", () => {
  let registry: OneRegistry;

  beforeEach(() => {
    registry = new OneRegistryClass();
  });

  it("creates content-addressed entry IDs", () => {
    const entry = createRegistryEntry(agentManifest("agent-a"));
    expect(entry.entryId).toMatch(/^[a-f0-9]{64}$/);
    expect(entry.kind).toBe("agent");
  });

  it("same manifest = same entryId (deduplication)", () => {
    const m1 = agentManifest("dedup-agent");
    const m2 = { ...m1, createdAt: m1.createdAt }; // identical
    expect(entryIdFor(m1)).toBe(entryIdFor(m2));
  });

  it("different manifest = different entryId", () => {
    const m1 = agentManifest("agent-a");
    const m2 = agentManifest("agent-b");
    expect(entryIdFor(m1)).not.toBe(entryIdFor(m2));
  });

  it("verifyEntryId returns true for valid entries", () => {
    const entry = createRegistryEntry(agentManifest("verify-agent"));
    expect(verifyEntryId(entry)).toBe(true);
  });

  it("register and getById round-trip", () => {
    const manifest = agentManifest("roundtrip-agent");
    const entryId = registry.register(manifest);
    const entry = registry.getById(entryId);
    expect(entry).toBeDefined();
    expect(entry!.entryId).toBe(entryId);
    expect(entry!.kind).toBe("agent");
    expect(entry!.manifest.name).toBe("roundtrip-agent");
  });

  it("idempotent registration does not duplicate", () => {
    const manifest = agentManifest("idempotent-agent");
    const id1 = registry.register(manifest);
    const id2 = registry.register(manifest);
    expect(id1).toBe(id2);
    expect(registry.size()).toBe(1);
    expect(registry.stats().totalEntries).toBe(1);
  });

  it("getByName returns entry by name", () => {
    const manifest = agentManifest("named-agent");
    registry.register(manifest);
    const result = registry.getByName("named-agent");
    expect(result.found).toBe(true);
    expect(result.entry!.manifest.name).toBe("named-agent");
    expect(result.matches).toContainEqual(result.entry!.entryId);
  });

  it("getByName returns not found for unknown name", () => {
    const result = registry.getByName("nonexistent");
    expect(result.found).toBe(false);
    expect(result.matches).toEqual([]);
  });

  it("listByKind filters by kind", () => {
    registry.register(agentManifest("suite-agent"));
    registry.register(suiteManifest("test-suite"));
    registry.register(suiteManifest("test-suite-2"));

    const agents = registry.listByKind("agent");
    const suites = registry.listByKind("suite");

    expect(agents.length).toBe(1);
    expect(suites.length).toBe(2);
    expect(agents[0].kind).toBe("agent");
    expect(suites[0].kind).toBe("suite");
  });

  it("listAll returns all entries", () => {
    registry.register(agentManifest("all-agent"));
    registry.register(suiteManifest("all-suite"));
    const all = registry.listAll();
    expect(all.length).toBe(2);
  });

  it("stats returns correct counts", () => {
    registry.register(agentManifest("stats-agent-1"));
    registry.register(agentManifest("stats-agent-2"));
    registry.register(suiteManifest("stats-suite"));

    const stats = registry.stats();
    expect(stats.totalEntries).toBe(3);
    expect(stats.byKind.agent).toBe(2);
    expect(stats.byKind.suite).toBe(1);
    expect(stats.byKind.dataset).toBe(0);
  });

  it("clear removes all entries", () => {
    registry.register(agentManifest("clear-agent"));
    expect(registry.size()).toBe(1);
    registry.clear();
    expect(registry.size()).toBe(0);
    expect(registry.getById("any-id")).toBeUndefined();
  });
});
