import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * A library nobody imports is not a feature, it is a fixture.
 *
 * `@crucible/argus` passed 24 tests for weeks with zero production importers: every input
 * that touched the outside world was supplied by its own test file, so the deterministic
 * re-run the design makes the centre of the product could not actually run. The count that
 * mattered was "who calls this", and nothing was checking it.
 *
 * This is that check. It fails if the only importer of the verifier or the content service
 * is a test, which is the exact shape of the failure this repository keeps rediscovering.
 */

const ROOT = fileURLToPath(new URL("../../..", import.meta.url));

function sources(dir: string, found: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry === "dist" || entry === ".next" || entry === ".git") continue;
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) sources(full, found);
    else if (/\.(ts|mjs)$/.test(entry)) found.push(full);
  }
  return found;
}

function productionImporters(specifier: string): string[] {
  const hits: string[] = [];
  for (const dir of ["apps", "packages", "scripts"]) {
    for (const file of sources(path.join(ROOT, dir))) {
      const rel = path.relative(ROOT, file).replaceAll("\\", "/");
      // A test file counting as a caller is precisely the illusion being guarded against.
      if (/\/(test|tests)\//.test(rel) || /\.(test|spec)\.[tm]js$/.test(rel)) continue;
      if (readFileSync(file, "utf8").includes(specifier)) hits.push(rel);
    }
  }
  return hits;
}

describe("the verifier has a production caller", () => {
  it("@crucible/argus is imported by something that is not a test", () => {
    const callers = productionImporters("@crucible/argus");
    expect(
      callers.length,
      "nothing outside its own test directory imports @crucible/argus, so the deterministic " +
        "re-run cannot execute. Add a production caller rather than deleting this check.",
    ).toBeGreaterThan(0);
  });

  it("the content service is imported by something that is not a test", () => {
    const callers = productionImporters("ContentService");
    expect(callers.length, "ContentService has no production caller").toBeGreaterThan(0);
  });

  it("the round trip is reachable as a command, not just as a file", () => {
    const pkg = JSON.parse(readFileSync(path.join(ROOT, "package.json"), "utf8"));
    expect(Object.keys(pkg.scripts)).toContain("verify:roundtrip");
  });

  /**
   * The seeds post `SeedContent.sol`'s constants onto a chain. If nothing recomputes them from
   * the bytes, editing a fixture leaves a digest that resolves to nothing — and the only witness
   * is a skeptic who cannot fetch the spec. So the check has to exist, be a command, and be wired
   * into the job that runs on every push. Each of the three is a separate way to lose it, and a
   * script nobody invokes is how PR #15's pagination ended up merged and undeployed.
   */
  it("the seed digest check exists, is a command, and is wired into CI", () => {
    expect(existsSync(path.join(ROOT, "scripts/seed-content.mjs")), "the pinning step is gone").toBe(true);

    const pkg = JSON.parse(readFileSync(path.join(ROOT, "package.json"), "utf8"));
    expect(Object.keys(pkg.scripts)).toContain("seed:check");

    const ci = readFileSync(path.join(ROOT, ".github/workflows/ci.yml"), "utf8");
    expect(
      ci.includes("npm run seed:check"),
      "seed:check is not run by ci.yml, so a fixture edit could post a digest that resolves to nothing",
    ).toBe(true);
  });

  /**
   * The injection guard was this file's own failure mode in its worst shape: the package was
   * built, its own suite passed, `forge-runner` listed it as a dependency — and nothing that
   * runs in production called it. `scripts/live-agent.mjs` constructs the LLM agent without the
   * `wrapUntrusted` option, so the sponsor's spec fell through to a raw pass-ahead while this
   * module's header comment claimed it "is wrapped by wrapUntrusted before it ever reaches the
   * model".
   *
   * The assertion is on the import statement and the default, not on a substring:
   * `productionImporters` above matches comments, and forge-runner named
   * `@crucible/agent-security` in two doc comments for weeks while importing nothing. A wiring
   * check that reads prose as a caller is the decoration it exists to detect.
   */
  it("the prompt-injection guard is imported by the agent that runs it", () => {
    const agent = readFileSync(path.join(ROOT, "packages/forge-runner/src/agent.ts"), "utf8");
    expect(
      /import\s*\{[^}]*\bwrapUntrusted\b[^}]*\}\s*from\s*"@crucible\/agent-security"/.test(agent),
      "forge-runner no longer imports wrapUntrusted, so an untrusted spec can reach a model",
    ).toBe(true);
    expect(
      /import\s*\{[^}]*\bscanRetrieved\b/.test(agent),
      "scanRetrieved is gone, so suite output from the sandbox is no longer classified",
    ).toBe(true);
    expect(
      agent.includes("opts.wrapUntrusted ??"),
      "the guard is no longer the default — a caller that forgets the option now sends raw spec text",
    ).toBe(true);
  });

  /**
   * A step named "install foundry (pinned tarball)" that piped the download straight into
   * `tar` was a pin on the version tag and nothing else. The digests now live in one file, and
   * this check is what keeps the next agent from pasting a bare curl back into a workflow.
   *
   * Order matters, not just presence: verifying after extraction would let the job run the
   * unverified binary for the length of the check.
   */
  it("no workflow fetches a build tool without the digest gate, and the gate checks before it extracts", () => {
    const dir = path.join(ROOT, ".github/workflows");
    for (const file of readdirSync(dir)) {
      if (!file.endsWith(".yml")) continue;
      const text = readFileSync(path.join(dir, file), "utf8");
      expect(
        text,
        `${file} downloads a release archive directly — route it through scripts/install-tool.sh, ` +
          "which compares a pinned digest before anything is unpacked",
      ).not.toContain("releases/download");
    }

    const gate = readFileSync(path.join(ROOT, "scripts/install-tool.sh"), "utf8");
    // Assert on the command that runs, never on the file's prose. This file documents how to
    // re-measure a digest, and those comments contain both `sha256sum` and `--strict`; an
    // `includes("--strict")` assertion here stayed green after the flag was deleted from the
    // check itself. Caught by mutating the check on 2026-10-23 and watching nothing go red.
    const lines = gate
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter((l) => !l.startsWith("#"));
    const check = lines.find((l) => l.includes("sha256sum --check"));
    const extract = lines.find((l) => l.startsWith("tar xzf"));
    expect(check, "install-tool.sh has no sha256sum --check line that actually runs").toBeDefined();
    expect(check, "the digest comparison must be --strict: a malformed line has to be an error").toContain(
      "--strict",
    );
    expect(extract, "install-tool.sh no longer extracts anything").toBeDefined();
    // Verification before extraction, not merely both present: a check that runs after
    // `tar xzf` lets the job execute the unverified binary for the length of the comparison.
    expect(lines.indexOf(check!)).toBeLessThan(lines.indexOf(extract!));
  });

  /**
   * The ship rung, checked as wiring and not as prose.
   *
   * `release.yml` opened with "every deploy that reached main and passed its own probes is a
   * release" and hung itself off a `workflow_run` trigger. A `workflow_dispatch` run raises no
   * downstream `workflow_run`, and the promotion starts `deploy` by name precisely because a
   * GITHUB_TOKEN push raises no event — so the ladder's own deploys never tagged a release, and
   * the only tag that existed was asked for by hand. Measured 2026-10-25: the chained deploys of
   * 2026-10-24 each created a release run (correctly skipped, their gates were red) while the
   * deploy that shipped the site created none. The comment held for the case that never ships and
   * failed for the case that does, which is what a check on the executed statement catches and a
   * check on the file's explanation cannot.
   */
  it("the deploy that ships also asks for the release, and nothing waits on an event that never arrives", () => {
    // Comments are where these files explain the rule they are coded against — release.yml names
    // `workflow_run` three times to say why it is gone. Every assertion below runs over the lines
    // that execute, the same fold that kept the install-tool check from grading its own docs.
    const commands = (text: string) =>
      text
        .split(/\r?\n/)
        .map((l) => l.trim())
        .filter((l) => l !== "" && !l.startsWith("#"));

    const release = commands(readFileSync(path.join(ROOT, ".github/workflows/release.yml"), "utf8"));
    expect(
      release.find((l) => /^workflow_run:$/.test(l)),
      "release.yml is triggered by a completed workflow again — a dispatched deploy raises no such event, so main ships untagged",
    ).toBeUndefined();
    expect(
      release.find((l) => l.includes("github.event.workflow_run")),
      "release.yml reads its triggerer's conclusion again, a field that is never present on the only path that runs it",
    ).toBeUndefined();

    const deploy = readFileSync(path.join(ROOT, ".github/workflows/deploy.yml"), "utf8");
    const steps = deploy.split(/\n {6}- name: /);
    const askAt = steps.findIndex((s) => commands(s).some((l) => l.includes("gh workflow run release.yml")));
    expect(
      askAt,
      "deploy.yml no longer asks for the release by name; the tag is left to an event GitHub does not deliver",
    ).toBeGreaterThanOrEqual(0);
    // Last, not merely present: asked for before the probes, a deploy that never shipped would
    // still publish a release note describing a build nobody is serving.
    expect(askAt, "the release is asked for before the deployment is probed").toBe(steps.length - 1);
    expect(
      commands(steps[askAt]).some((l) => l.startsWith("if ! gh run watch") && l.includes("--exit-status")),
      "the release is dispatched and forgotten, so a failed tag leaves main serving with a green deploy",
    ).toBe(true);
  });

  /**
   * The rollback, checked the same way — on the statements that run, and on their order.
   *
   * A deploy that swaps and then fails its probes used to leave the broken build serving and merely
   * report the fact. The 2026-10-24 incident was recovered by hand on the box, by someone who knew
   * the old images could be re-tagged; `crucible-web:rollback-20261024c` was still on that disk 26
   * hours later as proof. These four checks are what stop the automation decaying back into that
   * memory: the tag must happen BEFORE the build (after it, `:latest` is already the new image and
   * the tag preserves nothing), the restore must be the reverse direction, it must run only on a
   * failed job, and it must refuse when the swap never happened — because most of this job's
   * refusals fire before the swap, and re-pointing `:latest` then would take a healthy site down to
   * undo a change that was never made.
   */
  it("the deploy can put the previous build back, and only when it is the one that broke it", () => {
    const deploy = readFileSync(path.join(ROOT, ".github/workflows/deploy.yml"), "utf8")
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter((l) => l !== "" && !l.startsWith("#"));

    const tagAt = deploy.findIndex((l) => l.includes('docker tag "crucible-$s:latest" "crucible-$s:$stamp"'));
    const buildAt = deploy.findIndex((l) => l.includes("build web api keeper seed"));
    const restoreAt = deploy.findIndex((l) => l.includes('docker tag "crucible-$s:$stamp" "crucible-$s:latest"'));

    expect(tagAt, "the deploy no longer keeps the images it is about to overwrite — there is nothing to roll back to").toBeGreaterThanOrEqual(0);
    expect(buildAt, "the build step this check is ordered against has changed shape").toBeGreaterThanOrEqual(0);
    expect(tagAt, "the tag runs after the build, so it tags the new image and preserves nothing").toBeLessThan(buildAt);
    expect(restoreAt, "nothing points `:latest` back at the kept image — the rollback is one-way").toBeGreaterThanOrEqual(0);

    let header = restoreAt;
    while (header >= 0 && !deploy[header].startsWith("- name: ")) header -= 1;
    expect(header, "the restore is not inside a named step").toBeGreaterThanOrEqual(0);
    expect(
      deploy.slice(header, header + 4).some((l) => l.startsWith("if: failure()")),
      "the rollback runs on every deploy instead of only a failed one, so a green run can swap images under a healthy site",
    ).toBe(true);

    expect(
      deploy.some((l) => l.includes("touch /tmp/crucible-swapped")),
      "the swap no longer records that it happened, so the rollback cannot tell a failed deploy from a refusal that never touched anything",
    ).toBe(true);
    expect(
      deploy.some((l) => l.includes("if [ ! -e /tmp/crucible-swapped ]")),
      "the rollback no longer refuses when the swap never happened",
    ).toBe(true);
  });
});
