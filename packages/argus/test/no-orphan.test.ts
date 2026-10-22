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
});
