import { afterEach, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, readdir, rm, utimes } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { reapContainers, reapWorkspaces, runningSandboxLabels, type ExecFn } from "../src/sandbox.js";

/**
 * The reapers are host hygiene, and hygiene that cannot be turned red is
 * decoration: a reaper that removed running containers would kill a live
 * suite, and one that reaped a tier-4 workspace an hour into a legal run
 * would destroy evidence mid-creation. Each test below pins one of those
 * behaviours as an end state — the container gone or still present, the
 * directory gone or still present — not as a count the caller chose to
 * believe.
 */

interface FakeCall {
  args: string[];
}

function fakeDocker(psOutput: string, psCode = 0) {
  const calls: FakeCall[] = [];
  let rmCode = 0;
  const exec: ExecFn = async (_bin, args) => {
    calls.push({ args });
    if (args.includes("ps")) {
      return { stdout: psOutput, stderr: "", code: psCode, timedOut: false, durationMs: 0 };
    }
    return { stdout: "", stderr: "", code: rmCode, timedOut: false, durationMs: 0 };
  };
  return {
    exec,
    calls,
    rmTargets: () =>
      calls
        .filter((c) => c.args.includes("rm"))
        .map((c) => c.args[c.args.length - 1]!),
    failRm: () => {
      rmCode = 1;
    },
  };
}

describe("reapContainers", () => {
  it("force-removes only the containers that already finished", async () => {
    const { exec, rmTargets } = fakeDocker(
      "abc111 exited\ndef222 running\nghi333 created\njkl444 dead\n",
    );
    const removed = await reapContainers(exec);
    expect(removed).toBe(3);
    // `running` is a suite somebody may still be watching. `exited`, `created`
    // and `dead` are finished stories.
    expect(rmTargets()).toEqual(["abc111", "ghi333", "jkl444"]);
  });

  it("never touches a container the daemon reports as running or paused", async () => {
    const { exec, rmTargets } = fakeDocker("mno555 running\npqr666 paused\n");
    expect(await reapContainers(exec)).toBe(0);
    expect(rmTargets()).toEqual([]);
  });

  it("does not count a removal the daemon refused", async () => {
    const { exec, rmTargets, failRm } = fakeDocker("abc111 exited\n");
    failRm();
    expect(await reapContainers(exec)).toBe(0);
    expect(rmTargets()).toEqual(["abc111"]);
  });

  it("treats a daemon that refuses to list as nothing to reap", async () => {
    const { exec, rmTargets } = fakeDocker("", 1);
    expect(await reapContainers(exec)).toBe(0);
    expect(rmTargets()).toEqual([]);
  });

  it("treats an unusable docker CLI as nothing to reap", async () => {
    const exec: ExecFn = async () => {
      throw new Error("cannot execute docker: ENOENT");
    };
    await expect(reapContainers(exec)).resolves.toBe(0);
  });
});

describe("reapWorkspaces", () => {
  const bases: string[] = [];

  async function freshBase(): Promise<string> {
    const base = await mkdtemp(join(tmpdir(), "crucible-reap-probe-"));
    bases.push(base);
    return base;
  }

  afterEach(async () => {
    while (bases.length > 0) {
      await rm(bases.pop()!, { recursive: true, force: true });
    }
  });

  function hoursAgo2(h: number): Date {
    return new Date(Date.now() - h * 3_600_000);
  }

  it("reaps a workspace nothing has touched for a day, and keeps the fresh one", async () => {
    const base = await freshBase();
    const stale = join(base, "crucible-run-stale");
    const fresh = join(base, "crucible-run-fresh");
    await mkdir(join(stale, "repo"), { recursive: true });
    await mkdir(fresh, { recursive: true });
    // Backdate after the children exist: creating `repo/` refreshed the root's
    // mtime, which is exactly what a real workspace looks like at creation.
    await utimes(stale, hoursAgo2(48), hoursAgo2(48));
    await utimes(join(stale, "repo"), hoursAgo2(48), hoursAgo2(48));

    expect(await reapWorkspaces(24 * 3_600_000, base)).toBe(1);
    await expect(readdir(stale)).rejects.toThrow();
    await expect(readdir(fresh)).resolves.toEqual([]);
  });

  it("spares a stale-rooted workspace whose repo is being written — a live tier-4 run", async () => {
    const base = await freshBase();
    const live = join(base, "crucible-run-live");
    await mkdir(join(live, "repo"), { recursive: true });
    // The root has not moved since the workspace was created (a tier-4 suite is
    // allowed a 1h wall clock, longer than the old 1h reaper threshold), but the
    // agent is writing into `repo/` right now.
    await utimes(live, hoursAgo2(48), hoursAgo2(48));

    expect(await reapWorkspaces(24 * 3_600_000, base)).toBe(0);
    await expect(readdir(live)).resolves.toEqual(["repo"]);
  });

  it("ignores directories outside the crucible-run- prefix", async () => {
    const base = await freshBase();
    const unrelated = join(base, "not-crucible-work");
    await mkdir(unrelated, { recursive: true });
    await utimes(unrelated, hoursAgo2(96), hoursAgo2(96));

    expect(await reapWorkspaces(24 * 3_600_000, base)).toBe(0);
    await expect(readdir(unrelated)).resolves.toEqual([]);
  });

  it("treats an unreadable base dir as nothing to reap", async () => {
    const base = await freshBase();
    await rm(base, { recursive: true, force: true });
    bases.pop();
    await expect(reapWorkspaces(24 * 3_600_000, base)).resolves.toBe(0);
  });
});

function hoursAgo2(h) {
  return new Date(Date.now() - h * 3_600_000);
}

describe("reapWorkspaces ownership guard", () => {
  const bases2: string[] = [];

  async function freshBase2(): Promise<string> {
    const base = await mkdtemp(join(tmpdir(), "crucible-reap-own-"));
    bases2.push(base);
    return base;
  }

  afterEach(async () => {
    while (bases2.length > 0) {
      await rm(bases2.pop()!, { recursive: true, force: true });
    }
  });

  it("never reaps a workspace a running container still occupies, however stale", async () => {
    const base = await freshBase2();
    const owned = join(base, "crucible-run-owned");
    await mkdir(join(owned, "repo"), { recursive: true });
    await utimes(owned, hoursAgo2(96), hoursAgo2(96));
    await utimes(join(owned, "repo"), hoursAgo2(96), hoursAgo2(96));

    expect(
      await reapWorkspaces(24 * 3_600_000, base, new Set(["crucible-run-owned"])),
    ).toBe(0);
    await expect(readdir(owned)).resolves.toEqual(["repo"]);
  });

  it("reaps a stale neighbour the daemon does not claim", async () => {
    const base = await freshBase2();
    const stale = join(base, "crucible-run-abandoned");
    await mkdir(stale, { recursive: true });
    await utimes(stale, hoursAgo2(48), hoursAgo2(48));

    expect(await reapWorkspaces(24 * 3_600_000, base, new Set(["crucible-run-someone-else"]))).toBe(1);
    await expect(readdir(stale)).rejects.toThrow();
  });
});

describe("runningSandboxLabels", () => {
  function execReturning(stdout: string, code = 0): ExecFn {
    return async () => ({ stdout, stderr: "", code, timedOut: false, durationMs: 0 });
  }

  it("parses the crucible label values out of docker's label list", async () => {
    const exec = execReturning(
      "crucible.sandbox=crucible-run-abc,other=x\ncrucible.sandbox=crucible-run-def\n",
    );
    const live = await runningSandboxLabels(exec);
    expect(live.has("crucible-run-abc")).toBe(true);
    expect(live.has("crucible-run-def")).toBe(true);
    expect(live.size).toBe(2);
  });

  it("answers an empty set when the daemon refuses to list", async () => {
    const live = await runningSandboxLabels(execReturning("", 1));
    expect(live.size).toBe(0);
  });
});
