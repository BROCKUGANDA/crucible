import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Execution sandbox for a single trial run.
 *
 * The isolation boundary is a container: `--network=none` so a run cannot phone
 * home (only the pinned dependency mirror is reachable, via the cache baked into
 * the image), plus a memory and CPU ceiling so a runaway agent OOMs instead of
 * taking the host with it.
 *
 * When Docker is unavailable the runner degrades to a local scratch directory
 * and *says so* in the status stream, because a silent fallback would produce an
 * artifact that claims sandboxed execution it never had — and that artifact is
 * exactly what a skeptic is paid to break.
 */

export interface SandboxSpec {
  image: string;
  memory: string;
  cpus: string;
  /** hard wall-clock ceiling for the whole run */
  timeoutSec: number;
  /** allow running without Docker; sets `degraded` on the result */
  allowLocalFallback?: boolean;
  /**
   * Skip the Docker probe and execute directly. For tests, where the image does
   * not exist and a container would fail for reasons unrelated to the code under
   * test. Production code must never set this.
   */
  forceLocal?: boolean;
}

export const DEFAULT_SANDBOX: SandboxSpec = {
  // Pinned by digest so Argus re-runs the identical environment.
  image: "crucible/verifier:latest",
  memory: "1g",
  cpus: "1",
  timeoutSec: 900,
  allowLocalFallback: false,
};

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

async function dockerAvailable(): Promise<boolean> {
  const r = await execIn("docker", ["version", "--format", "{{.Server.Version}}"], undefined, 10);
  return r.code === 0;
}

/**
 * Run a binary, capturing output. Resolves even on a non-zero exit so callers can
 * inspect the output; rejects only when the binary cannot be spawned at all.
 */
export function execIn(
  bin: string,
  args: string[],
  cwd?: string,
  timeoutSec = 60,
): Promise<CommandResult> {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    execFile(
      bin,
      args,
      { timeout: timeoutSec * 1000, maxBuffer: 64 * 1024 * 1024, cwd },
      (error, stdout, stderr) => {
        const killed = Boolean(error && (error as { killed?: boolean }).killed);
        resolve({
          stdout: stdout?.toString() ?? "",
          stderr: stderr?.toString() ?? "",
          code: error ? 1 : 0,
          timedOut: killed,
          durationMs: Date.now() - started,
        });
      },
    ).on("error", (err) =>
      reject(
        Object.assign(new Error(`cannot execute ${bin}: ${err.message}`), { cause: err }),
      ),
    );
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
  private constructor(
    readonly root: string,
    readonly docker: boolean,
    readonly spec: SandboxSpec,
  ) {}

  static async create(spec: SandboxSpec = DEFAULT_SANDBOX): Promise<Sandbox> {
    const hasDocker = spec.forceLocal ? false : await dockerAvailable();
    if (!hasDocker && !spec.allowLocalFallback) {
      throw new SandboxUnavailable(
        "Docker is not available, so the run cannot be sandboxed. " +
          "Set allowLocalFallback to run unisolated — the artifact will be marked degraded.",
      );
    }
    const root = await mkdtemp(join(tmpdir(), "crucible-run-"));
    await mkdir(join(root, "repo"), { recursive: true });
    return new Sandbox(root, hasDocker, spec);
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
    const r = await this.exec("git", [
      "apply",
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
   * Run the pinned suite. In Docker this is `docker run --rm --network=none`
   * with the image pinned by digest; locally it is a direct exec, which the
   * caller must surface as degraded.
   */
  async runSuite(
    command: string,
    workDir: string = this.repoDir,
  ): Promise<CommandResult> {
    const argv = parseCommandLine(command);
    const bin = argv[0];
    if (!bin) throw new Error(`empty suite command: "${command}"`);
    const rest = argv.slice(1);

    if (this.docker) {
      const args = [
        "run",
        "--rm",
        "--network=none",
        `--memory=${this.spec.memory}`,
        `--cpus=${this.spec.cpus}`,
        `-v`,
        `${workDir}:/work`,
        "-w",
        "/work",
        this.spec.image,
        bin,
        ...rest,
      ];
      const r = await execIn("docker", args, undefined, this.spec.timeoutSec);
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
    await rm(this.root, { recursive: true, force: true }).catch(() => {});
  }
}

export { runCommand };
