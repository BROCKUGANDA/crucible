import { describe, expect, it } from "vitest";
import { GraderRegistry } from "../src/eval/registry.js";

describe("GraderRegistry (gate 433)", () => {
  it("register requires an RFC — model swap is never silent", () => {
    const reg = new GraderRegistry();
    expect(() => reg.register(1, "stub", "v1", "")).toThrow(/RFC/);
    expect(() => reg.register(1, "stub", "v1", "RFC-001")).not.toThrow();
  });

  it("rejects duplicate grader versions", () => {
    const reg = new GraderRegistry();
    reg.register(1, "stub", "v1", "RFC-001");
    expect(() => reg.register(1, "frontier", "v2", "RFC-002")).toThrow(/already registered/);
  });

  it("active looks up by graderVersion", () => {
    const reg = new GraderRegistry();
    reg.register(1, "stub", "v1", "RFC-001");
    reg.register(2, "frontier", "v2", "RFC-002");

    const r1 = reg.active(1);
    expect(r1?.modelId).toBe("stub");
    expect(r1?.promptVersion).toBe("v1");
    expect(r1?.rfc).toBe("RFC-001");

    const r2 = reg.active(2);
    expect(r2?.modelId).toBe("frontier");
    expect(r2?.rfc).toBe("RFC-002");

    expect(reg.active(99)).toBeUndefined();
  });

  it("latest returns the highest version", () => {
    const reg = new GraderRegistry();
    reg.register(1, "stub", "v1", "RFC-001");
    reg.register(3, "frontier", "v3", "RFC-003");
    reg.register(2, "mid", "v2", "RFC-002");

    const latest = reg.latest();
    expect(latest?.graderVersion).toBe(3);
    expect(latest?.modelId).toBe("frontier");
  });

  it("bump creates a new version from an existing one", () => {
    const reg = new GraderRegistry();
    reg.register(1, "stub", "v1", "RFC-001");
    reg.bump(1, 2, "frontier", "v2", "RFC-002");

    expect(reg.active(1)?.modelId).toBe("stub");
    expect(reg.active(2)?.modelId).toBe("frontier");
    expect(reg.active(2)?.rfc).toBe("RFC-002");
  });

  it("bump rejects unknown source version", () => {
    const reg = new GraderRegistry();
    expect(() => reg.bump(1, 2, "frontier", "v2", "RFC-002")).toThrow(/no such grader version/);
  });

  it("all returns the append-only audit trail", () => {
    const reg = new GraderRegistry();
    reg.register(1, "stub", "v1", "RFC-001");
    reg.register(2, "frontier", "v2", "RFC-002");

    const all = reg.all();
    expect(all.length).toBe(2);
    expect(all[0].graderVersion).toBe(1);
    expect(all[1].graderVersion).toBe(2);
  });
});
