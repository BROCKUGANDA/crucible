import { afterAll, describe, expect, it } from "vitest";
import { Sandbox, execIn, SandboxOOM, SandboxTimeout, type SandboxSpec } from "../src/sandbox.js";

/**
 * The sandbox's Docker path, actually exercised.
 *
 * Every other runner test passes `forceLocal: true` and so never runs a container — which
 * left the audit's core complaint standing: the CPU/memory/egress/read-only/output claims
 * were set in `sandbox.ts` but tested only as argv strings, never as enforcement. These tests
 * run the real `docker run` and assert what the KERNEL and the CONTAINER did, not what a flag
 * said. They are the difference between "the command included --network=none" (a claim) and
 * "the workload could not reach the internet" (a fact).
 *
 * They require a working Docker daemon and a pullable test image. Following the `Fork.t.sol`
 * discipline in HARDENING.md (lines 34-36), when those are missing the suite reports these as
 * SKIPPED — visible in the describe title and in stdout — rather than as green tests that
 * asserted nothing. A silent pass on missing Docker is the exact failure mode this file exists
 * to remove.
 */

// A small image with a shell and a python, enough to build each enforcement primitive without
// depending on the forge verifier. The enforcement under test is what Docker does to the
// CONTAINER (network, cgroups, mount flags); the workload inside is incidental.
const TEST_IMAGE = "python:3.12-alpine";

// The real verifier image, present only where it has been built
// (docker build -t crucible/verifier:latest -f packages/forge-runner/Dockerfile.verifier .).
const VERIFIER_IMAGE = "crucible/verifier:latest";

async function dockerDaemonUp(): Promise<boolean> {
  const v = await execIn("docker", ["version", "--format", "{{.Server.Version}}"], undefined, 20);
  return v.code === 0;
}

async function ensureImage(image: string): Promise<boolean> {
  let inspect = await execIn("docker", ["image", "inspect", image], undefined, 20);
  if (inspect.code === 0) return true;
  // Pull once so a `docker run` never has to fetch the tag inline under --network=none.
  await execIn("docker", ["pull", image], undefined, 300);
  inspect = await execIn("docker", ["image", "inspect", image], undefined, 20);
  return inspect.code === 0;
}

// Probed at module load, before `describe` runs, so the skip condition is decided once and is
// visible in the test titles. Failures here are expected (no Docker) and must not throw.
const daemonUp = await dockerDaemonUp();
const testImageReady = daemonUp ? await ensureImage(TEST_IMAGE) : false;
const verifierImageReady = daemonUp ? await ensureImage(VERIFIER_IMAGE) : false;

const enforcementReady = testImageReady;

if (!daemonUp) {
  // Loud and honest, exactly as the fork tests announce "126 passed, 4 skipped".
  console.log(
    "SKIPPING Docker sandbox enforcement: no reachable Docker daemon. These tests assert real " +
      "container isolation and there is nothing to assert them against. They report SKIPPED, " +
      "not passed.",
  );
} else if (!enforcementReady) {
  console.log(
    `SKIPPING Docker sandbox enforcement: Docker is up but ${TEST_IMAGE} could not be made ` +
      "available. Reporting SKIPPED, not passed.",
  );
}

const tracked: Sandbox[] = [];
afterAll(async () => {
  await Promise.all(tracked.map((s) => s.cleanup()));
});

async function dockerSandbox(over: Partial<SandboxSpec> = {}): Promise<Sandbox> {
  const sandbox = await Sandbox.create({
    image: TEST_IMAGE,
    memory: "1g",
    cpus: "1",
    timeoutSec: 30,
    // No fallback, no probe-skip: these tests only make sense as a real container.
    allowLocalFallback: false,
    forceLocal: false,
    ...over,
  });
  tracked.push(sandbox);
  return sandbox;
}

// The enforcement tests. `it.skipIf` keeps each one visible as a skipped case rather than
// collapsing the file into a single skip, so the count of hardening claims stays on the record.
const testEnforce = it.skipIf(!enforcementReady);

describe(`Docker sandbox enforcement${enforcementReady ? "" : " — SKIPPED (needs Docker + " + TEST_IMAGE + ")"}`, () => {
  testEnforce(
    "egress is denied: a workload that dials out cannot reach the internet, and fails closed",
    async () => {
      const sandbox = await dockerSandbox();
      await sandbox.writeFile(
        "egress.py",
        [
          "import urllib.request",
          "# Any reachable host fails the same way under --network=none: no DNS, no route.",
          "print(urllib.request.urlopen('http://example.com', timeout=5).read()[:8])",
          "",
        ].join("\n"),
      );
      const r = await sandbox.runSuite("python3 egress.py");
      // The observed failure, not the flag: the run must NOT succeed and must NOT have
      // fetched bytes. A resolver/connection error on stderr is the proof the network is gone.
      expect(r.stdout).not.toMatch(/b'/); // the printed body would be bytes like b'<html'
      expect(r.code).not.toBe(0);
      expect(r.stderr + r.stdout).toMatch(
        /name resolution|Temporary failure|getaddrinfo|Network is unreachable|No route to host|Errno |URLError|timed out/i,
      );
    },
    90_000,
  );

  testEnforce(
    "memory is capped: a workload that allocates past the limit is OOM-killed, and the parent keeps serving",
    async () => {
      // 512 MB allocation against a 64 MB ceiling. Wrapped in `sh -c` so the shell reaps the
      // signal-killed child and writes "Killed" to stderr — one way `runSuite` classifies it.
      //
      // The assertion is deliberately about the CAP, not about which way the runtime chose
      // to fail: a Python that lacks the memory raises MemoryError and exits non-zero, a
      // Python that is killed by the cgroup surfaces as SandboxOOM, and an image without
      // Python exits 127. All three mean the allocation did not succeed. The one outcome
      // that must never appear is "survived" — that is what a missing cap looks like, and
      // it is why this test is worth running even though its failure mode varies.
      const sandbox = await dockerSandbox({ memory: "64m" });
      await sandbox.writeFile("oom.py", "b = bytearray(512 * 1024 * 1024)\nprint('survived')\n");
      const attempt = await sandbox
        .runSuite('sh -c "python3 oom.py"')
        .then((result) => ({ threw: false as const, result }))
        .catch((error: unknown) => ({ threw: true as const, error }));

      if (attempt.threw) {
        expect(attempt.error).toBeInstanceOf(SandboxOOM);
      } else {
        expect(
          attempt.result.stdout,
          "a 512 MB allocation succeeded under a 64 MB cap — the cap is not being enforced",
        ).not.toContain("survived");
        expect(attempt.result.code).not.toBe(0);
      }

      // The whole point of a cgroup: the runaway died inside its container, the sandbox and
      // its parent are unharmed and still execute the next request.
      const follow = await sandbox.runSuite('python3 -c "print(2)"');
      expect(follow.stdout).toContain("2");
    },
    90_000,
  );

  testEnforce(
    "wall-clock is capped: a workload that sleeps past the timeout is terminated, and the queue survives",
    async () => {
      // The budget has to be long enough to start a container and short enough to cut a
      // sleep, because the same sandbox is reused for the follow-up below and its timeout
      // applies to that call too. At 2s this assertion was about how fast `docker run`
      // answers on an idle machine rather than whether the cap bites, and it failed on a
      // loaded runner while passing on an unloaded one. 120s of sleep cannot be reached
      // inside 10s by anything but a working timeout.
      const sandbox = await dockerSandbox({ timeoutSec: 10 });
      await sandbox.writeFile("sleep.py", "import time\ntime.sleep(120)\nprint('woke')\n");
      await expect(sandbox.runSuite("python3 sleep.py")).rejects.toBeInstanceOf(SandboxTimeout);

      // The sandbox is not poisoned by an expired run: it accepts the next job.
      const follow = await sandbox.runSuite('python3 -c "print(3)"');
      expect(follow.code).toBe(0);
      expect(follow.stdout).toContain("3");
    },
    90_000,
  );

  testEnforce(
    "output is capped: a workload that floods stdout is truncated, not buffered unbounded into the parent",
    async () => {
      const sandbox = await dockerSandbox();
      const MAX_BUFFER = 64 * 1024 * 1024;
      await sandbox.writeFile(
        "flood.py",
        // Write well past execIn's 64 MB maxBuffer. If the cap were absent this would grow the
        // parent's heap without bound; with it, collection stops and the excess is refused.
        "import sys\nsys.stdout.buffer.write(b'x' * (100 * 1024 * 1024))\nsys.stdout.flush()\n",
      );
      const r = await sandbox.runSuite("python3 flood.py");
      // Bounded: the parent never holds more than the cap, and the overflow is surfaced as a
      // non-clean exit rather than a silently complete 100 MB string.
      expect(r.stdout.length).toBeLessThanOrEqual(MAX_BUFFER + 1024 * 1024);
      expect(r.stdout.length).toBeGreaterThan(0);
      expect(r.code).not.toBe(0);
    },
    120_000,
  );

  testEnforce(
    "the filesystem is read-only: a workload that tries to persist outside /tmp and /work is refused",
    async () => {
      const sandbox = await dockerSandbox();
      await sandbox.writeFile(
        "writetarget.py",
        [
          "import sys",
          "# /tmp is tmpfs and /work is the bind mount; the image root filesystem is read-only.",
          "try:",
          "    open('/crucible-persistence-attempt.txt', 'w').write('x')",
          "    print('WROTE')",
          "except OSError as e:",
          "    print('BLOCKED', e.errno, e.strerror, file=sys.stderr)",
          "    sys.exit(3)",
          "",
        ].join("\n"),
      );
      const r = await sandbox.runSuite("python3 writetarget.py");
      expect(r.stdout).not.toContain("WROTE");
      expect(r.code).not.toBe(0);
      expect(r.stderr).toMatch(/Read-only file system|30/);
    },
    90_000,
  );
});

// The flag the audit found missing is now in `runSuite`. This test is the guard that it does not
// break the thing the sandbox actually runs: `forge build` as uid 1000, under --cap-drop=ALL.
// If a capability ever turns out to be load-bearing for compilation, this fails loudly rather
// than shipping a sandbox that silently cannot build.
const forgeReady = verifierImageReady;
if (daemonUp && !forgeReady) {
  console.log(
    `SKIPPING cap-drop forge-workload test: Docker is up but ${VERIFIER_IMAGE} is not built. ` +
      "Build it with the Dockerfile.verifier to run this.",
  );
}
const testForge = it.skipIf(!forgeReady);

describe(`cap-drop keeps the forge workload working${forgeReady ? "" : " — SKIPPED (needs crucible/verifier)"}`, () => {
  testForge(
    "forge build compiles a trivial contract inside the hardened sandbox",
    async () => {
      const sandbox = await Sandbox.create({
        image: VERIFIER_IMAGE,
        memory: "1g",
        cpus: "1",
        timeoutSec: 180,
        allowLocalFallback: false,
        forceLocal: false,
      });
      tracked.push(sandbox);
      await sandbox.writeFile("foundry.toml", '[profile.default]\nsrc = "src"\n');
      await sandbox.writeFile(
        "src/Forge.sol",
        "// SPDX-License-Identifier: MIT\npragma solidity ^0.8.0;\ncontract Forge { uint256 public x = 1; }\n",
      );
      const r = await sandbox.runSuite("forge build");
      expect(r.code).toBe(0);
      expect((r.stdout + r.stderr).toLowerCase()).toContain("compil");
    },
    240_000,
  );
});
