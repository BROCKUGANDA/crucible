import { beforeEach, describe, expect, it } from "vitest";
import { dlq } from "../src/dlq.js";

/**
 * The dead-letter queue reports failures, so it must not be the thing that fails.
 *
 * `detail.slice(0, 300)` threw a `TypeError` when the detail was not a string — and the
 * detail was not a string exactly when the failure was already strange: a caller that
 * did `(err as Error).message` on a non-`Error` throw produced `undefined`. That
 * `TypeError` was raised INSIDE the catch block handling the original failure, so it
 * escaped the handler entirely.
 *
 * In the indexer that was fatal. The throw left `watch()`'s promise rejected, nothing
 * awaited it, and Node killed the process: a malformed throw took the whole indexer
 * with it, while the thing being reported was a malformed throw.
 */
describe("the dead-letter queue", () => {
  beforeEach(() => dlq.clear());

  it("accepts a detail that is not a string", () => {
    expect(() => dlq.push("sync", undefined as unknown as string)).not.toThrow();
    expect(dlq.summary().lastDetail).toBe("undefined");
  });

  it("accepts a thrown value that is not an Error", () => {
    expect(() => dlq.push("sync", "a string failure")).not.toThrow();
    expect(dlq.summary().lastDetail).toBe("a string failure");
  });

  it("names an object it cannot otherwise describe", () => {
    expect(() => dlq.push("sync", { code: 7 } as unknown as string)).not.toThrow();
    expect(dlq.summary().lastDetail).toContain("7");
  });

  it("survives a value that cannot be serialised", () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    expect(() => dlq.push("sync", circular as unknown as string)).not.toThrow();
    expect(typeof dlq.summary().lastDetail).toBe("string");
  });

  it("keeps the ring bounded", () => {
    for (let i = 0; i < 250; i++) dlq.push("sync", `failure ${i}`);
    const summary = dlq.summary();
    expect(summary.size).toBe(100);
    // The newest is kept, the oldest is dropped.
    expect(summary.lastDetail).toBe("failure 249");
  });
});
