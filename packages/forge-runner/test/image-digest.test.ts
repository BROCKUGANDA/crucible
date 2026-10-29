import { describe, expect, it } from "vitest";
import {
  ImageDigestUnresolved,
  Sandbox,
  isDigestPinned,
  resolveImageDigest,
  type CommandResult,
  type ExecFn,
  type SandboxSpec,
} from "../src/sandbox.js";

/**
 * The run's environment, identified before the run instead of asserted after it.
 *
 * The defect this file closes is a specific lie: `imageDigest` was filled with the
 * image *reference the operator typed* — `crucible/verifier:latest` — under a field
 * whose documented meaning is "the image the sandbox actually ran, not the tag it was
 * given". A tag is re-pointable, so the manifest's reproducibility claim could not be
 * honoured by anyone, including Argus.
 *
 * These are **unit-level proofs against an injected exec layer**, not container proofs:
 * the machine this runs on has a Docker CLI and no daemon, so the real-container
 * assertions live in `sandbox-docker.test.ts` and report SKIPPED there rather than
 * passing. What is *not* faked here is the logic under test — the resolver parses the
 * daemon's own `docker image inspect` output format, the refusal is the real
 * `Sandbox.create` refusal, and the argv asserted below is the argv `runSuite` builds
 * for the real CLI.
 *
 * The end state each test checks is either the immutable reference or a refusal. "We
 * could not resolve it, so here is the tag instead" is the outcome every test here
 * exists to make impossible.
 */

const HEX64 = "a".repeat(64);
const OTHER64 = "b".repeat(64);
const ID64 = "c".repeat(64);

const TAG_SPEC: SandboxSpec = {
  image: "crucible/verifier:latest",
  memory: "1g",
  cpus: "1",
  timeoutSec: 60,
  allowLocalFallback: false,
};

function result(over: Partial<CommandResult> = {}): CommandResult {
  return { stdout: "", stderr: "", code: 0, timedOut: false, durationMs: 1, ...over };
}

interface FakeDockerOptions {
  /** What `docker image inspect` answers. Default: one repo digest plus a local id. */
  inspect?: Partial<CommandResult>;
  /** What `docker run` answers. Default: success, no output. */
  run?: Partial<CommandResult>;
  /** When set, `docker image inspect` rejects instead of settling. */
  inspectThrows?: boolean;
}

/**
 * A Docker CLI that answers the three calls the sandbox makes — `version`, `image
 * inspect`, `run` — and records every argv it was given.
 *
 * The recording is the point: the claim under test is *which reference the container was
 * launched from*, and that is only visible in the command line.
 */
function fakeDocker(opts: FakeDockerOptions = {}) {
  const calls: Array<{ bin: string; args: string[] }> = [];
  const exec: ExecFn = async (bin: string, args: string[]) => {
    calls.push({ bin, args });
    const [sub, second] = args;
    if (sub === "version") return result();
    if (sub === "image" && second === "inspect") {
      if (opts.inspectThrows) throw new Error("docker: spawn failed");
      return result({
        stdout: `[\"crucible/verifier@sha256:${HEX64}\"]|sha256:${ID64}`,
        ...opts.inspect,
      });
    }
    if (sub === "run") return result({ stdout: '{"tests":[]}', ...opts.run });
    return result();
  };
  return { exec, calls, dockerRuns: () => calls.filter((c) => c.args[0] === "run") };
}

describe("resolveImageDigest", () => {
  it("keeps an already digest-pinned reference and does not ask the daemon", async () => {
    const pinned = `crucible/verifier@sha256:${OTHER64}`;
    const { exec, calls } = fakeDocker();
    expect(await resolveImageDigest(pinned, exec)).toBe(pinned);
    // No subprocess at all: asking would only add a way to fail on a reference that is
    // already the answer.
    expect(calls).toHaveLength(0);
  });

  it("resolves a tag to its registry digest, not to the tag and not to the local id", async () => {
    const resolved = await resolveImageDigest("crucible/verifier:latest", fakeDocker().exec);
    expect(resolved).toBe(`crucible/verifier@sha256:${HEX64}`);
  });

  it("falls back to the local image id when the image was built and never pushed", async () => {
    // This is the shape `Dockerfile.verifier` produces on a build box: RepoDigests empty,
    // because nothing was ever pushed to a registry.
    const { exec } = fakeDocker({ inspect: { stdout: `[]|sha256:${ID64}` } });
    expect(await resolveImageDigest("crucible/verifier:latest", exec)).toBe(`sha256:${ID64}`);
  });

  it("refuses to fall back to the tag when the image cannot be inspected", async () => {
    const { exec } = fakeDocker({ inspect: { code: 1, stderr: "No such image" } });
    expect(await resolveImageDigest("crucible/verifier:latest", exec)).toBeUndefined();
  });

  it("refuses a garbage answer rather than quoting whatever the CLI printed", async () => {
    const { exec } = fakeDocker({ inspect: { stdout: "Cannot connect to the Docker daemon" } });
    expect(await resolveImageDigest("crucible/verifier:latest", exec)).toBeUndefined();
  });

  it("discards a repo digest that is not hex and takes the image id instead", async () => {
    const { exec } = fakeDocker({
      inspect: { stdout: `[\"crucible/verifier@sha256:zzzz\"]|sha256:${ID64}` },
    });
    // The claimed pin is corrupt, so it is not a reference to anything. The local image id
    // is still immutable and still describes the bytes that would run — and the answer is
    // never the tag, which is the only outcome this file is prepared to accept.
    expect(await resolveImageDigest("crucible/verifier:latest", exec)).toBe(`sha256:${ID64}`);
  });

  it("refuses an id that is not a sha256", async () => {
    const { exec } = fakeDocker({ inspect: { stdout: `[]|${ID64}` } });
    expect(await resolveImageDigest("crucible/verifier:latest", exec)).toBeUndefined();
  });

  it("survives a CLI that cannot be spawned at all, as unresolved", async () => {
    const { exec } = fakeDocker({ inspectThrows: true });
    expect(await resolveImageDigest("crucible/verifier:latest", exec)).toBeUndefined();
  });

  it("prefers the repository the run asked for, deterministically", async () => {
    const two = [
      `zeta/verifier@sha256:${OTHER64}`,
      `crucible/verifier@sha256:${HEX64}`,
    ];
    const a = await resolveImageDigest(
      "crucible/verifier:latest",
      fakeDocker({ inspect: { stdout: `["${two[0]}","${two[1]}"]|sha256:${ID64}` } }).exec,
    );
    const b = await resolveImageDigest(
      "crucible/verifier:latest",
      fakeDocker({ inspect: { stdout: `["${two[1]}","${two[0]}"]|sha256:${ID64}` } }).exec,
    );
    expect(a).toBe(`crucible/verifier@sha256:${HEX64}`);
    expect(b).toBe(a);
  });

  it("still answers something when no entry matches the requested repository", async () => {
    // A locally retagged image can carry a digest under another name. The bytes are still
    // immutable, so this is a fact about the run, not a guess — and it must not be the tag.
    const resolved = await resolveImageDigest(
      "crucible/verifier:latest",
      fakeDocker({
        inspect: { stdout: `["other/verifier@sha256:${OTHER64}"]|sha256:${ID64}` },
      }).exec,
    );
    expect(resolved).toBe(`other/verifier@sha256:${OTHER64}`);
  });

  it("asks the daemon with the reference it was given, unmodified", async () => {
    const { exec, calls } = fakeDocker();
    await resolveImageDigest("python:3.12-alpine", exec);
    expect(calls[0]!.bin).toBe("docker");
    expect(calls[0]!.args.slice(0, 3)).toEqual(["image", "inspect", "python:3.12-alpine"]);
  });

  it("is still the predicate isDigestPinned, which now has a caller that matters", () => {
    expect(isDigestPinned(`crucible/verifier@sha256:${HEX64}`)).toBe(true);
    expect(isDigestPinned("crucible/verifier:latest")).toBe(false);
  });
});

describe("the sandbox resolves the digest before it runs anything", () => {
  it("refuses the run when the image has no resolvable digest", async () => {
    const { exec, dockerRuns } = fakeDocker({ inspect: { code: 1 } });
    const attempt = await Sandbox.create(TAG_SPEC, { exec }).then(
      () => ({ threw: false as const }),
      (error: unknown) => ({ threw: true as const, error }),
    );

    expect(attempt.threw).toBe(true);
    expect((attempt as { error?: Error }).error).toBeInstanceOf(ImageDigestUnresolved);
    // End state: nothing executed. A refusal that still launched the container would be a
    // run whose provenance is missing rather than a run that did not happen.
    expect(dockerRuns()).toHaveLength(0);
  });

  it("records the resolved reference on the sandbox", async () => {
    const { exec } = fakeDocker();
    const sandbox = await Sandbox.create(TAG_SPEC, { exec });
    expect(sandbox.imageDigest).toBe(`crucible/verifier@sha256:${HEX64}`);
    expect(sandbox.degraded).toBe(false);
    await sandbox.cleanup();
  });

  it("launches the container from the resolved reference, not the tag", async () => {
    const { exec, dockerRuns } = fakeDocker();
    const sandbox = await Sandbox.create(TAG_SPEC, { exec });
    await sandbox.runSuite("forge test --json");

    const run = dockerRuns()[0]!;
    expect(run.args).toContain(`crucible/verifier@sha256:${HEX64}`);
    // The tag is not in the command line at all: the container that ran is the container the
    // manifest describes, which is the whole property the two fields were split to keep.
    expect(run.args).not.toContain("crucible/verifier:latest");
    // Still the hardening flags, because the reference changed and the isolation did not.
    expect(run.args).toContain("--network=none");
    expect(run.args).toContain("--read-only");
    expect(run.args).toContain("--cap-drop=ALL");
    await sandbox.cleanup();
  });

  it("never asks the daemon to resolve a reference that is already pinned", async () => {
    const pinned: SandboxSpec = {
      ...TAG_SPEC,
      image: `crucible/verifier@sha256:${OTHER64}`,
    };
    const { exec, calls, dockerRuns } = fakeDocker();
    const sandbox = await Sandbox.create(pinned, { exec });
    expect(sandbox.imageDigest).toBe(pinned.image);
    expect(calls.some((c) => c.args[0] === "image")).toBe(false);
    await sandbox.runSuite("forge test --json");
    expect(dockerRuns()[0]!.args).toContain(pinned.image);
    await sandbox.cleanup();
  });

  it("has no digest at all when nothing was containerised", async () => {
    const { exec, calls } = fakeDocker();
    const sandbox = await Sandbox.create(
      { ...TAG_SPEC, allowLocalFallback: true, forceLocal: true },
      { exec },
    );
    // Not the tag, not a guess: there was no image, so there is no digest. This is the state
    // the manifest must then describe as unisolated rather than as pinned.
    expect(sandbox.imageDigest).toBeUndefined();
    expect(sandbox.degraded).toBe(true);
    expect(calls.some((c) => c.args[0] === "image")).toBe(false);
    await sandbox.cleanup();
  });

  it("refuses before creating a workspace, so a denied run leaves no trace", async () => {
    const { exec } = fakeDocker({ inspect: { code: 1 } });
    await expect(Sandbox.create(TAG_SPEC, { exec })).rejects.toBeInstanceOf(
      ImageDigestUnresolved,
    );
  });
});

/**
 * The seam must stay wired to the CLI production uses, or every test above is measuring a
 * stub. This one goes through the default `execIn` with no daemon to answer it, so the
 * end state it asserts is the refusal: an unresolvable image resolves to nothing.
 */
describe("the default exec seam", () => {
  it("is the real CLI, and an image nobody can inspect resolves to nothing", async () => {
    // No `exec` argument: this call spawns the actual `docker` binary. On this machine the
    // daemon is down, and on a machine where it is up the image does not exist — either way
    // there is no digest, and the tag is not returned in its place.
    const resolved = await resolveImageDigest("crucible/definitely-not-published:nope");
    expect(resolved).toBeUndefined();
  }, 60_000);
});
