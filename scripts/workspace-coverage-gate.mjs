#!/usr/bin/env node
/**
 * Fails when a workspace has a script that CI does not run — or when CI runs one that no longer
 * exists.
 *
 * The TypeScript job enumerates its workspaces instead of using `npm run test --workspaces`, and
 * the enumeration is load-bearing: `crucible-contracts` has a `test` script that invokes forge,
 * which that job does not install, so a blanket glob would fail the job for a reason that has
 * nothing to do with the push. An enumerated list carries the opposite risk, which is quieter: add
 * a package and every gate simply keeps passing without it. `apps/juror` arrived with 70 tests and
 * appeared in no list — the CI step that this gate now checks had to be edited by hand, and nobody
 * noticed, because nothing was looking.
 *
 * So the list stays, and this file makes it impossible to forget.
 */

import { readFileSync, readdirSync, existsSync, statSync } from "node:fs";
import path from "node:path";

/**
 * Workspaces intentionally absent from this job, and why. An exclusion without a reason is how a
 * gate gets loosened one package at a time, so each entry has to say what owns it instead.
 */
const EXCLUDED = {
  // Needs forge and solc, which the Contracts (forge) job installs from a pinned tarball. Its
  // tests run there, along with build, fmt, coverage and slither.
  "crucible-contracts": "the Contracts (forge) job",
};

// Run from the repository root — which is where the job's working directory already is. Taking the
// root as an argument was how a second meaning crept into the one argument that names a file.
const ROOT = process.cwd();
const CI_FILE = path.resolve(process.argv[2] ?? ".github/workflows/ci.yml");

/**
 * The workspace package.json files, expanded by hand.
 *
 * `fs.globSync` would be one line and does not exist before node 22 — which is every job in this
 * file except the audit. A gate that throws on the runner's node version is a gate that stops
 * running while still printing nothing, so the two patterns this repo actually uses (`dir/*` and a
 * plain path) are resolved with `readdirSync`.
 */
function workspaces() {
  const root = JSON.parse(readFileSync(path.join(ROOT, "package.json"), "utf8"));
  const found = new Map();
  for (const pattern of root.workspaces ?? []) {
    const dirs = pattern.endsWith("/*")
      ? readdirSync(path.join(ROOT, pattern.slice(0, -2)))
          .map((entry) => path.join(ROOT, pattern.slice(0, -2), entry))
          .filter((dir) => existsSync(path.join(dir, "package.json")))
      : [path.join(ROOT, pattern)];
    for (const dir of dirs) {
      const file = path.join(dir, "package.json");
      if (!existsSync(file) || !statSync(dir).isDirectory()) continue;
      const pkg = JSON.parse(readFileSync(file, "utf8"));
      // Forward slashes always: a Dockerfile names paths with `/` on every platform, and comparing
      // a `path.relative` result against one on Windows turns every workspace into a mismatch.
      found.set(pkg.name, {
        name: pkg.name,
        dir: path.relative(ROOT, dir).replaceAll("\\", "/"),
        scripts: pkg.scripts ?? {},
      });
    }
  }
  return found;
}

/** The `--workspace <name>` entries inside the step whose name matches `stepName`. */
function listedInCi(ci, stepName) {
  const at = ci.indexOf(`- name: ${stepName}`);
  if (at < 0) throw new Error(`ci.yml has no step named "${stepName}" — the gate's anchor moved`);
  const next = ci.indexOf("\n      - name:", at + 1);
  const block = ci.slice(at, next < 0 ? ci.length : next);
  return new Set([...block.matchAll(/--workspace\s+(\S+)/g)].map((m) => m[1]));
}

/**
 * Every workspace manifest must be copied into every image that runs `npm ci`.
 *
 * This is the check that the juror's own Dockerfile made necessary, and the one that would have
 * caught a breakage already sitting in `develop`: `packages/argus` gained a `"@crucible/cidstore":
 * "*"` dependency, none of the three node images copied `packages/cidstore/package.json`, and so
 * `npm ci` in those images resolves a workspace that is not there and asks the registry for a
 * package that does not exist. Nothing noticed, because no CI job builds an image — the failure
 * lands at deploy time, on the machine serving the demo.
 *
 * A workspace can be left out safely only while nothing in the copied set names it. That is not
 * worth reasoning about per image, so the rule is the simple one: copy all of them.
 */
function dockerfiles(root) {
  const found = [];
  const consider = (dir) => {
    const file = path.join(dir, "Dockerfile");
    if (existsSync(file)) found.push(file);
  };
  // Two levels: `crucible-contracts/Dockerfile` and `apps/<name>/Dockerfile`, which is every image
  // this repository builds. A deeper nesting would need its own entry here, and failing loudly on
  // an unreadable directory beats skipping one silently.
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name === "node_modules" || entry.name.startsWith(".")) continue;
    consider(path.join(root, entry.name));
    if (entry.name === "apps" || entry.name === "packages") {
      for (const inner of readdirSync(path.join(root, entry.name), { withFileTypes: true })) {
        if (inner.isDirectory()) consider(path.join(root, entry.name, inner.name));
      }
    }
  }
  return found;
}

function checkImages(all) {
  const problems = [];
  for (const file of dockerfiles(ROOT)) {
    const text = readFileSync(file, "utf8");
    if (!/npm ci/.test(text)) continue; // an image that never installs node deps needs no manifests
    const copied = new Set(
      [...text.matchAll(/^COPY\s+(\S+\/package\.json)\s/gm)].map((m) => m[1].replace(/\/package\.json$/, "")),
    );
    const rel = path.relative(ROOT, file).replaceAll("\\", "/");
    for (const pkg of all.values()) {
      if (!copied.has(pkg.dir)) {
        problems.push(`${rel} runs npm ci but never copies ${pkg.dir}/package.json — add it before ${pkg.name}`);
      }
    }
    for (const dir of copied) {
      if (![...all.values()].some((p) => p.dir === dir)) {
        problems.push(`${rel} copies ${dir}/package.json, which is not a workspace`);
      }
    }
  }
  return problems;
}

function main() {
  const ci = readFileSync(CI_FILE, "utf8");
  const all = workspaces();
  if (all.size === 0) throw new Error("no workspaces found — is this running from the repository root?");

  const typecheck = listedInCi(ci, "typecheck (every workspace)");
  const test = listedInCi(ci, "test (every workspace)");

  const problems = [];
  for (const pkg of all.values()) {
    const expected = [
      ["typecheck", pkg.scripts.typecheck ? typecheck : null],
      ["test", pkg.scripts.test ? test : null],
    ];
    for (const [script, list] of expected) {
      if (list === null) continue; // no such script: nothing to cover
      if (!list.has(pkg.name)) {
        const owner = EXCLUDED[pkg.name];
        if (owner) continue;
        problems.push(`${pkg.name} has a "${script}" script (${pkg.dir}) that ci.yml never runs`);
      }
    }
  }

  // The other half: a name in the list that resolves to nothing is a step that passes because the
  // package it meant to test was renamed or deleted. `npm --workspace` would error on its own, but
  // only if the misspelling survives to the run, and a silent exclusion is what actually happened.
  for (const [list, stepName] of [
    [typecheck, "typecheck (every workspace)"],
    [test, "test (every workspace)"],
  ]) {
    for (const name of list) {
      if (!all.has(name)) problems.push(`ci.yml's "${stepName}" names ${name}, which is not a workspace`);
    }
  }

  // An exclusion has to stay honest too: a package listed here that now IS covered would mean the
  // exclusion was left behind after someone wired the job, and the next reader would trust a
  // comment that no longer describes anything.
  for (const [name, owner] of Object.entries(EXCLUDED)) {
    if (!all.has(name)) problems.push(`the gate excludes ${name} for ${owner}, but no such workspace exists`);
    if (test.has(name) || typecheck.has(name)) {
      problems.push(`${name} is excluded (${owner}) yet also listed in ci.yml — pick one`);
    }
  }

  problems.push(...checkImages(all));

  const covered = [...test].length;
  if (problems.length > 0) {
    console.error(`workspace coverage FAILED:\n  ${problems.join("\n  ")}`);
    process.exit(1);
  }
  console.log(
    `workspace coverage: ${all.size} workspaces, ${covered} in ci.yml, ${Object.keys(EXCLUDED).length} excluded by name (${Object.values(EXCLUDED).join(", ")})`,
  );
}

try {
  main();
} catch (err) {
  console.error(`workspace coverage FAILED: ${err.message}`);
  process.exit(1);
}
