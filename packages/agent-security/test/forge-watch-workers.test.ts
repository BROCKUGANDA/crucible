import { describe, expect, it } from "vitest";
import { idempotentMonitorProcessor, l0Processor } from "../src/forge-watch-workers.js";

describe("Forge Watch worker scaffolding", () => {
  it("rejects malformed payloads", async () => {
    const wrapped = idempotentMonitorProcessor(async () => ({ ok: true }));
    await expect(wrapped({ data: {} } as never)).rejects.toThrow(/invalid/);
    await expect(
      wrapped({ data: { schemaVersion: 2, runId: "r", phase: "l0" } } as never),
    ).rejects.toThrow(/invalid/);
  });

  it("runs a valid processor", async () => {
    let called = false;
    const wrapped = idempotentMonitorProcessor(async () => {
      called = true;
      return { ok: true };
    });
    await wrapped({
      data: { schemaVersion: 1, runId: "r1", phase: "l0", enqueuedAt: 1 },
      id: "j1",
    } as never);
    expect(called).toBe(true);
  });

  it("l0 scaffold returns ok without side effects", async () => {
    const res = await l0Processor({
      data: { schemaVersion: 1, runId: "r1", phase: "l0", enqueuedAt: 1 },
      id: "j1",
    } as never);
    expect(res.ok).toBe(true);
  });
});
