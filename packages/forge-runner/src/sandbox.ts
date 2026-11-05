import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, basename } from "node:path";

/**
 * Execution sandbox for a single trial run.
 *
 * The isolation boundary is a container: `--network=none` so a run cannot phone
 * home (only the pinned dependency mirror is reachable, via the cache baked into
 * the image), plus a memory and CPU ceiling so a runaway agent OOMs instead of
 * taking the host with it.
 *
 * When Docker is unavailable the run is refused. There is no fallback to local
 * execution: an artifact that claims sandboxed execution it never had is exactly
 * what a skeptic is paid to break, and a degraded run that says so is still a
 * run whose isolation cannot be verified. Fail closed.
 */

export interface SandboxSpec {
  image: string;
  memory: string;
  cpus: string;
  /** hard wall-clock ceiling for the whole run */
  timeoutSec: number;
  /**
   * Skip the Docker probe and execute directly. For tests, where the image does
   * not exist and a container would fail for reasons unrelated to the code under
   * test. Production code must never set this. When set, the sandbox is created
   * without Docker and without an image digest — the run is unisolated and the
   * caller must surface that fact.
   */
  forceLocal?: boolean;
}

/** The signature of `execIn`, so a test can drive the Docker CLI without a daemon. */
export type ExecFn = typeof execIn;

/**
 * The seams a Sandbox takes from outside its own process.
 *
 * Only one exists: the Docker CLI. The probe, the digest inspection and the container
 * launch all go through it, so a test can assert the whole container path — including
 * *which reference* `docker run` was handed — without a daemon. Host binaries (`git`, the
 * suite command under `forceLocal`) still execute for real.
 */
export interface SandboxDeps {
  exec?: ExecFn;
}

/**
 * A container is only reproducible if the reference it launched from is immutable.
 *
 * Two shapes qualify: a registry reference pinned at `@sha256:…`, which anybody can
 * re-pull, and a bare local image ID `sha256:…`, which identifies exactly the bytes
 * that ran on this host. A tag (`name:latest`) qualifies as neither — it is a name
 * that can be pointed at different bytes between two runs.
 */
const IMAGE_ID = /^sha256:[0-9a-f]{64}$/;
const PINNED_REF = /^[^\s@]+@sha256:[0-9a-f]{64}$/;

function isImmutableImageRef(ref: string): boolean {
  return IMAGE_ID.test(ref) || PINNED_REF.test(ref);
}

export const DEFAULT_SANDBOX: SandboxSpec = {
  // The verifier image, built locally from packages/forge-runner/Dockerfile.verifier and
  // referenced by its MUTABLE `:latest` tag — this is NOT a digest pin. An earlier comment here
  // claimed "pinned by digest so Argus re-runs the identical environment", which the value does
  // not do: `:latest` moves whenever the image is rebuilt, so it is the opposite of a pin. The
  // honest statement: the image is the same ENVIRONMENT by construction (the Dockerfile warms the
  // solc set every offline run needs), but reproducibility across machines and over time is only
  // real once the image is published to a registry and referenced by `@sha256:` digest. Argus's
  // re-run claim depends on that digest; the sandbox's isolation claim does not — Docker enforces
  // `--network=none`/`--memory`/`--read-only` regardless of how the tag is named.
  //
  // What the tag no longer does is *stand in for a digest in the manifest*. `Sandbox.create`
  // resolves whatever this names to its immutable reference (`resolveImageDigest`) before the run
  // executes, launches the container from that reference, and records it; a run whose image cannot
  // be resolved is refused rather than attested. Publishing the image by digest is still what
  // makes a re-run on another machine reproducible — this only stops the receipt from claiming
  // more than the tag can give.
  //
  // IMPORTANT: The `:latest` tag is the default only for local development, where the image is
  // rebuilt constantly. In production, set `CRUCIBLE_VERIFIER_IMAGE` to a digest-pinned reference
  // (`crucible/verifier@sha256:...`). The sandbox will refuse to run if the image cannot be
  // resolved to an immutable digest — there is no fallback to unisolated execution.
  image: "crucible/verifier:latest",
  memory: "1g",
  cpus: "1",
  timeoutSec: 900,
};

/**
 * The verifier image a run actually uses. `CRUCIBLE_VERIFIER_IMAGE` overrides
 * the `:latest` default so an operator can pin the published digest
 * (`crucible/verifier@sha256:…`) without a code change.
 *
 * The default stays mutable because local development rebuilds the image constantly,
 * and a digest baked into source would be stale the day it landed. In production,
 * always set this environment variable to a digest-pinned reference.
 */
export function resolveVerifierImage(env: NodeJS.ProcessEnv = process.env): string {
  return env.CRUCIBLE_VERIFIER_IMAGE?.trim() || DEFAULT_SANDBOX.image;
}

/** True when `image` names an immutable digest rather than a moving tag. */
export function isDigestPinned(image: string): boolean {
  return /@sha256:[0-9a-f]{64}$/.test(image.trim());
}

/**
 * Raised when a container run cannot be told apart from any other run of the same tag.
 *
 * The runner refuses rather than recording the tag: `imageDigest` is a reproducibility
 * claim, and a claim that cannot be checked is worse than no claim, because a skeptic
 * reads the field's name, not its provenance.
 */
export class ImageDigestUnresolved extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ImageDigestUnresolved";
  }
}

/**
 * The immutable reference of the image `image` currently resolves to, or `undefined`.
 *
 * Asked of the same Docker CLI the run itself shells out to, so the answer describes the
 * environment the container will actually get — not the tag the operator typed. The
 * precedence is deliberate:
 *
 *  1. a reference already pinned at `@sha256:` is returned untouched, with no subprocess,
 *     because there is nothing to resolve and asking would only add a failure mode;
 *  2. `RepoDigests` — what a skeptic can `docker pull` and re-run;
 *  3. the local image `Id` — immutable and exact, but only verifiable on this host. An
 *     image built from `Dockerfile.verifier` and never pushed has no `RepoDigests` at all,
 *     so without this tier every local run would be refused;
 *  4. nothing. `undefined`, and the caller fails closed.
 *
 * Step 4 is the whole point. Returning the tag here would put a mutable name in a field
 * named `imageDigest` and make the manifest's reproducibility claim unfalsifiable — the
 * defect this function exists to remove.
 */
export async function resolveImageDigest(
  image: string,
  exec: ExecFn = execIn,
  timeoutSec = 30,
): Promise<string | undefined> {
  const ref = image.trim();
  if (!ref) return undefined;
  if (isDigestPinned(ref)) return ref;

  // One call, both fields. `|` cannot appear in a hex digest or an image name, and the
  // JSON array is terminated by `]`, so the last pipe is an unambiguous separator.
  let result: CommandResult;
  try {
    result = await exec(
      "docker",
      ["image", "inspect", ref, "--format", "{{json .RepoDigests}}|{{.Id}}"],
      undefined,
      timeoutSec,
    );
  } catch {
    return undefined;
  }
  if (result.code !== 0) return undefined;

  const out = result.stdout.trim();
  const sep = out.lastIndexOf("|");
  if (sep < 0) return undefined;

  const pinned = pinnedRepoDigests(out.slice(0, sep), ref);
  if (pinned) return pinned;

  const id = out.slice(sep + 1).trim();
  return IMAGE_ID.test(id) ? id : undefined;
}

/**
 * Pick the registry digest for `ref` among the digests the image carries.
 *
 * An image pushed to two registries has two `RepoDigests` entries pointing at the same
 * bytes; the run needs one deterministic string, or two runs of one image would emit two
 * manifests that `compareManifests` reports as different environments. The entry naming
 * the repository the run asked for wins; otherwise the sorted first, so the choice does
 * not depend on daemon ordering.
 */
function pinnedRepoDigests(repoDigestsJson: string, ref: string): string | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(repoDigestsJson);
  } catch {
    return undefined;
  }
  if (!Array.isArray(parsed)) return undefined;
  const candidates = parsed.filter(
    (entry): entry is string => typeof entry === "string" && isImmutableImageRef(entry.trim()),
  );
  if (candidates.length === 0) return undefined;
  const sorted = [...candidates].map((c) => c.trim()).sort();
  // The requested reference minus its tag — `python:3.12-alpine` -> `python`, and
  // `registry:5000/x:tag` -> `registry:5000/x` (a registry port is not a tag).
  const requested = ref.replace(/:[^:/]+$/, "");
  return sorted.find((c) => c.split("@")[0] === requested) ?? sorted[0];
}

export interface CommandResult {
  stdout: string;
  stderr: string;
  code: number;
  timedOut: boolean;
  durationMs: number;
}

export class SandboxUnavailable extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SandboxUnavailable";
  }
}

export class SandboxTimeout extends Error {
  constructor(readonly timeoutSec: number) {
    super(`sandbox exceeded ${timeoutSec}s`);
    this.name = "SandboxTimeout";
  }
}

export class SandboxOOM extends Error {
  constructor() {
    super("the sandbox melted — run exceeded its memory ceiling");
    this.name = "SandboxOOM";
  }
}

/**
 * Docker label stamped on every container a Sandbox starts. A run needs a handle that survives
 * the loss of its client process, and a label is how a caller — the timeout below, or whoever
 * is cleaning up after a crashed verifier — finds the containers one workspace owns.
 */
export const SANDBOX_LABEL = "crucible.sandbox";

/** The label value for a workspace: its directory name, unique per Sandbox (mkdtemp). */
export function sandboxLabel(root: string): string {
  return basename(root);
}

/**
 * In-process lease registry for live sandboxes.
 *
 * A crashed client cannot tell the daemon it is gone, so  previously
 * had no way to distinguish a container that belongs to a live Sandbox in THIS
 * process from one left by a crashed peer. This registry is the missing answer:
 *  registers its root on creation, Killing ollama...
Killing any opencode background...
SUCCESS: The process "opencode.exe" with PID 23248 has been terminated.
Done.
 deregisters it, and
 *  refuses to touch any container whose label is still registered.
 *
 * The registry is process-local by design — a container left by a *different*
 * process is exactly the orphan a reaper should reclaim. Cross-process leases
 * would require a shared store (see BLOCKED_FOR_HUMAN.md item 10).
 */
const LIVE_LEASES = new Set<string>();

export function registerLease(root: string): void {
  LIVE_LEASES.add(sandboxLabel(root));
}

export function deregisterLease(root: string): void {
  LIVE_LEASES.delete(sandboxLabel(root));
}

export function isLeased(rootOrLabel: string): boolean {
  const label = rootOrLabel.includes("/") ? basename(rootOrLabel) : rootOrLabel;
  return LIVE_LEASES.has(label);
}

export function liveLeases(): ReadonlySet<string> {
  return LIVE_LEASES;
}

async function dockerAvailable(exec: ExecFn = execIn): Promise<boolean> {
  const r = await exec("docker", ["version", "--format", "{{.Server.Version}}"], undefined, 10);
  return r.code === 0;
}

/**
 * Run a binary, capturing output. Resolves even on a non-zero exit so callers can
 * inspect the output; rejects only when the binary cannot be spawned at all.
 *
 * `onTimeout` runs the moment this call decides the budget is spent, and is the only way to
 * stop a child that supervises something the parent cannot signal. `execFile`'s own `timeout`
 * only reaches the child: measured on the CI runner with a 10s budget around
 * `docker run … python3 -c "time.sleep(120)"`, Node marked the CLI killed at 10s, the CLI
 * survived it (it stays attached while the container streams), the container stayed `Up`, and
 * the callback did not fire until 120 156ms — when the workload finished on its own. A caller
 * that cannot end the workload has not capped it, it has only stopped watching, so `runSuite`
 * uses the hook to destroy the container itself.
 *
 * The kill is SIGKILL rather than the default SIGTERM for the same reason: a cap that a
 * trapped signal can ignore is not a cap.
 */
export function execIn(
  bin: string,
  args: string[],
  cwd?: string,
  timeoutSec = 60,
  onTimeout?: () => void,
): Promise<CommandResult> {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    let timer: ReturnType<typeof setTimeout> | undefined;
    // Set by this watchdog, not by Node's `killed` flag: once the hook destroys the container,
    // the CLI exits on its own with a plain non-zero status and `killed` would read false.
    let outOfBudget = false;

    const settle = (
      error: Error & { killed?: boolean } | null,
      stdout: string | undefined,
      stderr: string | undefined,
    ) => {
      if (timer) clearTimeout(timer);
      resolve({
        stdout: stdout ?? "",
        stderr: stderr ?? "",
        code: error ? 1 : 0,
        timedOut: outOfBudget || Boolean(error?.killed),
        durationMs: Date.now() - started,
      });
    };

    const child = execFile(
      bin,
      args,
      { timeout: timeoutSec * 1000, maxBuffer: 64 * 1024 * 1024, cwd, killSignal: "SIGKILL" },
      (error, stdout, stderr) =>
        settle(error as (Error & { killed?: boolean }) | null, stdout?.toString(), stderr?.toString()),
    ).on("error", (err) => {
      if (timer) clearTimeout(timer);
      reject(Object.assign(new Error(`cannot execute ${bin}: ${err.message}`), { cause: err }));
    });

    timer = setTimeout(() => {
      outOfBudget = true;
      onTimeout?.();
      child.kill("SIGKILL");
    }, timeoutSec * 1000);
  });
}

const runCommand = (bin: string, args: string[], timeoutSec: number) =>
  execIn(bin, args, undefined, timeoutSec);

/**
 * Split a suite command into argv, honouring single and double quotes so a
 * command like `forge test --match-test "test deposit"` keeps its argument intact.
 * A plain `split(" ")` would shred quoted arguments, and the suite command is
 * pinned by the sponsor — mis-parsing it would run something they never wrote.
 */
export function parseCommandLine(command: string): string[] {
  const out: string[] = [];
  let current = "";
  let quote: '"' | "'" | null = null;
  let has = false;

  for (const ch of command) {
    if (quote) {
      if (ch === quote) quote = null;
      else current += ch;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      has = true;
      continue;
    }
    if (/\s/.test(ch)) {
      if (current.length > 0 || has) {
        out.push(current);
        current = "";
        has = false;
      }
      continue;
    }
    current += ch;
  }
  if (current.length > 0 || has) out.push(current);
  return out;
}

/**
 * A workspace the agent works in, plus the pinned suite it must satisfy.
 */
export class Sandbox {
  private runSeq = 0;

  private constructor(
    readonly root: string,
    readonly docker: boolean,
    readonly spec: SandboxSpec,
    /**
     * The immutable reference the container is launched from, resolved before the run.
     *
     * `undefined` exactly when no container ran (`degraded`) — there is then no image to
     * attest to, and inventing one from the requested tag is the lie this field exists to
     * stop. A containerised sandbox never has it absent: `create` refuses the run.
     */
    readonly imageDigest: string | undefined,
    /** The Docker-CLI seam (probe, inspect, run). Host binaries still use `execIn`. */
    private readonly dockerExec: ExecFn,
  ) {}

  static async create(
    spec: SandboxSpec = DEFAULT_SANDBOX,
    deps: SandboxDeps = {},
  ): Promise<Sandbox> {
    const exec = deps.exec ?? execIn;

    // `forceLocal` is the only way to skip Docker, and it is for tests only.
    // Production code must not set it: a run without a container has no isolation
    // to verify, and an artifact that claims sandboxed execution it never had is
    // exactly what a skeptic is paid to break.
    if (spec.forceLocal) {
      const root = await mkdtemp(join(tmpdir(), "crucible-run-"));
      await mkdir(join(root, "repo"), { recursive: true });
      registerLease(root);
      return new Sandbox(root, false, spec, undefined, exec);
    }

    // Docker is required for production runs. No fallback.
    const hasDocker = await dockerAvailable(exec);
    if (!hasDocker) {
      throw new SandboxUnavailable(
        "Docker is not available, so the run cannot be sandboxed. " +
          "Start the Docker daemon and try again. There is no fallback to unisolated execution.",
      );
    }

    // Resolved before the run, and before the workspace exists, so a refused run leaves
    // nothing behind. The fail-closed choice over "record the tag and carry on" is the
    // point: a tag here is a digest-shaped field nobody can falsify, and this path has
    // Docker available, so not knowing the digest means not having the environment.
    const imageDigest = await resolveImageDigest(spec.image, exec);
    if (!imageDigest) {
      throw new ImageDigestUnresolved(
        `Docker is up, but ${spec.image} cannot be resolved to an immutable digest, so this ` +
          "run cannot say which environment it executed in. Publish the verifier image by " +
          "digest, or set CRUCIBLE_VERIFIER_IMAGE to a @sha256: reference.",
      );
    }

    const root = await mkdtemp(join(tmpdir(), "crucible-run-"));
    await mkdir(join(root, "repo"), { recursive: true });
    registerLease(root);
    return new Sandbox(root, hasDocker, spec, imageDigest, exec);
  }

  get repoDir(): string {
    return join(this.root, "repo");
  }

  /** True when execution is NOT containerised. Recorded in the run status. */
  get degraded(): boolean {
    return !this.docker;
  }

  /** Write the trial's spec into the workspace so the agent can read it. */
  async writeSpec(specText: string): Promise<string> {
    const path = join(this.root, "SPEC.md");
    await writeFile(path, specText, "utf8");
    return path;
  }

  /**
   * Apply a unified diff inside the repo directory.
   *
   * A patch that does not apply is reported, not thrown: the caller decides
   * whether that ends the run or feeds the error back to the agent for another
   * iteration.
   */
  async applyPatch(patch: string): Promise<{ ok: boolean; message: string }> {
    const patchPath = join(this.repoDir, ".crucible-agent.patch");
    await writeFile(patchPath, patch, "utf8");

    // `--recount` recomputes hunk line counts from the patch body instead of trusting
    // the `@@ -a,b +c,d @@` header.
    //
    // This is not leniency for its own sake — it was added because a real model got it
    // wrong. qwen3.8-27b returned a hunk headed `@@ -7,6 +7,7 @@` whose body was
    // `-7,5 +7,8`, and git rejected the whole patch as corrupt. Models are good at
    // content and bad at arithmetic; making the loop hostage to that is a bad trade.
    //
    // It does NOT weaken the guard this system depends on: `--recount` still matches
    // context lines byte-for-byte and still refuses a patch that does not apply, so a
    // diff aiming at the pinned suite still fails here. Only the counts are ignored.
    const r = await this.exec("git", [
      "apply",
      "--recount",
      "--whitespace=nowarn",
      "-p1",
      ".crucible-agent.patch",
    ]);
    await rm(patchPath, { force: true }).catch(() => {});
    if (r.code === 0) return { ok: true, message: "patch applied" };
    return { ok: false, message: (r.stderr || r.stdout).trim().slice(0, 500) };
  }

  /** Run a binary inside the repo directory. */
  async exec(bin: string, args: string[], timeoutSec = 30): Promise<CommandResult> {
    return execIn(bin, args, this.repoDir, timeoutSec);
  }

  async writeFile(relative: string, contents: string): Promise<string> {
    const path = join(this.repoDir, relative);
    await mkdir(join(path, ".."), { recursive: true });
    await writeFile(path, contents, "utf8");
    return path;
  }

  async readFile(relative: string): Promise<string> {
    const { readFile } = await import("node:fs/promises");
    return readFile(join(this.repoDir, relative), "utf8");
  }

  /**
   * Run the pinned suite.
   *
   * In Docker this is `docker run --rm --network=none` against the **resolved immutable
   * reference** — `this.imageDigest`, a `@sha256:` repo digest or a local image ID — which
   * `create` obtained before the run started and refused to begin without. The launch
   * argument is deliberately not `spec.image`: passing the tag would let the tag move
   * between the inspection and the container, and would make the manifest's digest a
   * statement about a build the run did not use. Run by the resolved reference, the digest
   * in the manifest is the thing the daemon was told to start.
   *
   * When `forceLocal` is set (tests only), it is a direct exec with no container at all.
   * There is no image to name, because none ran. Production code must not use this path.
   */
  async runSuite(command: string, workDir: string = this.repoDir): Promise<CommandResult> {
    const argv = parseCommandLine(command);
    const bin = argv[0];
    if (!bin) throw new Error(`empty suite command: "${command}"`);
    const rest = argv.slice(1);

    if (this.docker) {
      // Guaranteed by `create`: a containerised sandbox always has its digest resolved, or
      // it does not exist. The fallback is unreachable and stays a fallback rather than a
      // throw, because throwing here would lose an artifact that already ran.
      const image = this.imageDigest ?? this.spec.image;
      // Named and labelled so the timeout below can reach the container. Without a name the
      // only handle to the run is the CLI's own process, and the CLI is not the workload —
      // see execIn. The sequence keeps successive runs of one sandbox from colliding.
      const label = sandboxLabel(this.root);
      const name = `${label}-${++this.runSeq}`;
      const args = [
        "run",
        "--rm",
        "--name",
        name,
        "--label",
        `${SANDBOX_LABEL}=${label}`,
        "--network=none",
        `--memory=${this.spec.memory}`,
        `--cpus=${this.spec.cpus}`,
        // Fork-bomb, host-write, and privilege-escalation caps. The work directory is
        // the only writable path; everything else in the image is read-only, and a
        // runaway process count dies at 128 instead of taking the host with it.
        "--pids-limit=128",
        "--read-only",
        "--tmpfs=/tmp:size=64m",
        "--user=1000:1000",
        // The audit's two missing hardening flags.
        //
        // `--cap-drop=ALL`: Docker hands a non-privileged container ~14 capabilities even as a
        // non-root user, and `forge build`/`forge test` is pure userspace compilation + EVM
        // execution as uid 1000 — it needs none of them. Dropping the whole set is the default
        // this sandbox should have always had; a suite that only passes with a capability added
        // back is a suite doing something the container should never have let it do.
        "--cap-drop=ALL",
        // `--security-opt=no-new-privileges` blocks setuid/setgid escalation across the exec.
        "--security-opt=no-new-privileges",
        // Seccomp, and why there is no explicit `--security-opt=seccomp=<profile>` here: Docker
        // already applies its curated default seccomp profile to every non-`--privileged`
        // container (unlike capabilities, which it grants by default), so `forge` and `solc` run
        // under a syscall allowlist out of the box. Shipping a custom profile here would replace
        // that maintained default with a hand-written list we have to keep in step with the
        // kernel ourselves — a larger maintenance surface for no added isolation in this threat
        // model. The one escape hatch it must not grow is `--privileged`, which would disable
        // seccomp and caps together; the flags above are only ever added, never gated off.
        `-v`,
        `${workDir}:/work`,
        "-w",
        "/work",
        image,
        bin,
        ...rest,
      ];
      const r = await this.dockerExec("docker", args, undefined, this.spec.timeoutSec, () => {
        // `--force` stops and removes in one call, so the container cannot outlive the budget
        // and `--rm` cannot be left waiting on a workload that ignores SIGTERM. The result is
        // discarded: whether this call reports success, the CLI's stream is closing and the run
        // is already recorded as timed out.
        void this.dockerExec("docker", ["rm", "--force", name], undefined, 15).catch(() => {});
      });
      if (r.timedOut) throw new SandboxTimeout(this.spec.timeoutSec);
      if (/OutOfMemory|Killed|oom-kill/i.test(r.stderr)) throw new SandboxOOM();
      return r;
    }

    const r = await execIn(bin, rest, workDir, this.spec.timeoutSec);
    if (r.timedOut) throw new SandboxTimeout(this.spec.timeoutSec);
    if (/OutOfMemory|Killed|oom-kill/i.test(r.stderr)) throw new SandboxOOM();
    return r;
  }

  async cleanup(): Promise<void> {
    deregisterLease(this.root);
    await rm(this.root, { recursive: true, force: true }).catch(() => {});
  }
}

export { runCommand };

/**
 * Reap labelled containers that no run is coming back for.
 *
 * Every suite runs under `docker run --rm`, so the daemon removes the container when
 * the workload ends, and the timeout hook force-removes it when the budget is spent.
 * What survives those two paths is the residue the reaper exists for: a container
 * left in `created` (the daemon wedged between create and start), `exited` (removal
 * at exit failed — a locked daemon, a restart mid-teardown) or `dead` (the daemon
 * failed to destroy it). All three are finished stories; `--force` on them reclaims
 * the record without stopping anything that is doing work.
 *
 * A container that is still `running` is deliberately left alone. Removing it would
 * need proof that no live Sandbox owns it, and this function has no lease registry
 * to ask — killing a running container can kill someone else's live suite. A crashed
 * client's container needs no reaper anyway: `--rm` is honoured by the daemon, so the
 * workload ends on its own wall clock and the daemon reclaims it.
 *
 * Returns the number of containers removed.
 */
export async function reapContainers(exec: ExecFn = execIn): Promise<number> {
  // State comes back with the ID so the removability decision is made here, in
  // reviewed code, rather than delegated to `--filter status=…` repetitions whose
  // OR/AND semantics have shifted across daemon versions.
  const finished = new Set(["created", "exited", "dead"]);
  // Labels come back so the lease registry can be consulted.
  const list2 = await exec(
    "docker",
    ["ps", "-a", "--filter", `label=${SANDBOX_LABEL}`, "--format", "{{.ID}}\t{{.State}}\t{{.Labels}}"],
    undefined,
    30,
  ).catch(() => ({ code: 1, stdout: "", stderr: "", timedOut: false, durationMs: 0 }));
  if (list2.code !== 0) return 0;

  const candidates: { id: string; state: string; label: string }[] = [];
  for (const line of list2.stdout.split("\n")) {
    if (!line.trim()) continue;
    // Support both tab-separated (new format) and space-separated (legacy/test format).
    const parts = line.includes("\t") ? line.split("\t") : line.trim().split(/\s+/);
    const id = parts[0];
    const state = parts[1];
    if (!id || !state) continue;
    let label = "";
    const labelsStr = parts[2] ?? "";
    for (const pair of labelsStr.split(",")) {
      const [key, value] = pair.trim().split("=");
      if (key === SANDBOX_LABEL && value) label = value;
    }
    candidates.push({ id, state, label });
  }

  let removed = 0;
  for (const { id, state, label } of candidates) {
    const isFinished = finished.has(state);
    const isRunningOrphan = state === "running" && label !== "" && !liveLeases().has(label);
    if (!isFinished && !isRunningOrphan) continue;

    const rm = await exec("docker", ["rm", "--force", id], undefined, 15).catch(() => ({
      code: 1,
      stdout: "",
      stderr: "",
      timedOut: false,
      durationMs: 0,
    }));
    if (rm.code === 0) removed++;
  }
  return removed;
}

/**
 * The workspace directories a *running* container currently occupies.
 *
 * This is the ownership evidence the reapers otherwise lack: a container carrying
 * `crucible.sandbox=<workspace>` in `running` state proves that workspace belongs
 * to a live suite, however stale its mtimes look — a lease keyed by what the daemon
 * itself reports rather than by wall-clock guesswork. One `docker ps` call; an
 * unusable CLI answers an empty set and the mtime guard stands alone.
 */
export async function runningSandboxLabels(exec: ExecFn = execIn): Promise<Set<string>> {
  const list = await exec(
    "docker",
    ["ps", "--filter", `label=${SANDBOX_LABEL}`, "--format", "{{.Labels}}"],
    undefined,
    30,
  ).catch(() => ({ code: 1, stdout: "", stderr: "", timedOut: false, durationMs: 0 }));
  const live = new Set<string>();
  if (list.code !== 0) return live;
  for (const line of list.stdout.split("\n")) {
    for (const pair of line.split(",")) {
      const [key, value] = pair.trim().split("=");
      if (key === SANDBOX_LABEL && value) live.add(value);
    }
  }
  return live;
}

/**
 * Reap temporary workspaces that no run is coming back for.
 *
 * Sandbox.create makes a `crucible-run-*` directory under the system temp dir; if the
 * process dies before cleanup, the directory survives — the common leftover, since
 * containers carry `--rm` and directories carry nothing. The age of a workspace is
 * the newest mtime among the root and its direct children, not the root's alone: the
 * root's mtime only moves when a direct child appears, while a live run keeps creating
 * files inside `repo/` — and a tier-4 suite is allowed a 1h wall clock, so a 1h
 * threshold could reap a workspace a run was still using. The default 24h outlasts
 * any legal run plus slack; a directory nothing has touched for that long is not
 * mid-run.
 *
 * `liveWorkspaces` is the ownership override: names reported live by
 * `runningSandboxLabels` are never reaped whatever their mtimes say. Passing it is
 * how the caller proves ownership from the daemon instead of assuming it.
 *
 * Writes deeper than one level under the root would not refresh the mtime guard;
 * nothing in the runner writes there without creating files inside `repo/`. If that
 * changes, this is the line to revisit.
 *
 * Returns the number of directories removed. `baseDir` exists for tests; production
 * scans the system temp dir.
 */
export async function reapWorkspaces(
  maxAgeMs: number = 86_400_000,
  baseDir: string = tmpdir(),
  liveWorkspaces?: Set<string>,
): Promise<number> {
  const { readdir, stat, rm } = await import("node:fs/promises");
  const now = Date.now();
  let removed = 0;

  try {
    const entries = await readdir(baseDir);
    for (const entry of entries) {
      if (!entry.startsWith("crucible-run-")) continue;
      // Ownership first, age second: a name the daemon reports as live is never a
      // candidate, whatever its mtimes claim.
      if (liveWorkspaces?.has(entry)) continue;
      const path = join(baseDir, entry);
      const st = await stat(path).catch(() => null);
      if (!st || !st.isDirectory()) continue;
      async function newestMtime(dir: string): Promise<number> {
        let newest = (await stat(dir).catch(() => null))?.mtimeMs ?? 0;
        const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
        for (const entry of entries) {
          const full = join(dir, entry.name);
          if (entry.isDirectory()) {
            newest = Math.max(newest, await newestMtime(full));
          } else {
            const cs = await stat(full).catch(() => null);
            if (cs && cs.mtimeMs > newest) newest = cs.mtimeMs;
          }
        }
        return newest;
      }
      const newest = await newestMtime(path);
      if (now - newest > maxAgeMs) {
        await rm(path, { recursive: true, force: true }).catch(() => {});
        removed++;
      }
    }
  } catch {
    // If the base dir cannot be read, there is nothing to reap — not a crash.
  }
  return removed;
}
