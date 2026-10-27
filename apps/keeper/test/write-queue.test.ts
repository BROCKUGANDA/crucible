import { describe, expect, it } from "vitest";
import { createWriteQueue } from "../src/write-queue";

/**
 * The one-writer lock for the keeper's account.
 *
 * The failure mode this file guards is two loops sending at the same instant
 * from the same account: the node hands both the same pending nonce, one
 * transaction replaces the other, and the keeper pays gas to learn a status
 * the contract already knew.
 */

describe("createWriteQueue", () => {
  it("never runs two passes at once", async () => {
    const queue = createWriteQueue();
    let active = 0;
    let maxActive = 0;
    const pass = () =>
      queue.run(async () => {
        active += 1;
        maxActive = Math.max(maxActive, active);
        await new Promise((r) => setTimeout(r, 5));
        active -= 1;
        return true;
      });
    await Promise.all([pass(), pass(), pass(), pass()]);
    expect(maxActive).toBe(1);
  });

  it("runs queued passes in arrival order", async () => {
    const queue = createWriteQueue();
    const order: string[] = [];
    const mk = (name: string) =>
      queue.run(async () => {
        await new Promise((r) => setTimeout(r, name === "first" ? 15 : 1));
        order.push(name);
      });
    await Promise.all([mk("first"), mk("second"), mk("third")]);
    expect(order).toEqual(["first", "second", "third"]);
  });

  it("keeps serving after a rejection", async () => {
    const queue = createWriteQueue();
    await expect(
      queue.run(async () => {
        throw new Error("reverted");
      }),
    ).rejects.toThrow("reverted");
    await expect(queue.run(async () => 42)).resolves.toBe(42);
  });

  it("reports waiting callers as depth", async () => {
    const queue = createWriteQueue();
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const first = queue.run(() => gate);
    const second = queue.run(async () => undefined);
    const third = queue.run(async () => undefined);
    // One tick: the first pass has now started (and is held by the gate), so
    // exactly the two later callers are still waiting.
    await Promise.resolve();
    expect(queue.depth()).toBe(2);
    release();
    await Promise.all([first, second, third]);
    expect(queue.depth()).toBe(0);
  });
});
