#!/usr/bin/env node
/**
 * Auto-version: the next semver tag, computed from the highest `vX.Y.Z` tag in this repository.
 *
 * Why a script rather than a marketplace action: a published tag is a claim about what shipped,
 * and a third-party action that decides it is a second source of truth beside git. This reads git
 * and writes git, and nothing else.
 *
 * The commit messages here are prose ("The deploy refuses a stale address…"), not Conventional
 * Commits, so nothing infers a bump from them — the caller says patch, minor or major. The default
 * is patch: a deploy is a patch until a human says otherwise.
 *
 * Usage:
 *   node scripts/version.mjs --bump patch|minor|major [--dry-run] [--apply]
 *
 * Without --apply it prints the tag it would create. --apply requires a clean tree, refuses a tag
 * that already exists, creates an annotated tag, and prints its name.
 */
import { execFileSync } from "node:child_process";

const KINDS = ["patch", "minor", "major"];

/**
 * The next version, given every tag in the repository and the part to bump.
 *
 * Exported so the rule can be exercised without a repository: a version computation that is only
 * tested by running the release is a version computation that is not tested.
 */
export function nextVersion(tags, kind) {
  if (!KINDS.includes(kind)) throw new Error(`bump must be one of ${KINDS.join(", ")}`);

  const versions = tags
    .filter((t) => /^v\d+\.\d+\.\d+$/.test(t))
    .map((t) => t.slice(1).split(".").map(Number));

  if (versions.length === 0) {
    // Nothing here has ever claimed 1.0. The first release is 0.1.0, and an explicit major bump
    // on an unreleased tree means 1.0.0 rather than 0.1.0.
    return kind === "major" ? "1.0.0" : "0.1.0";
  }

  const [major, minor, patch] = versions.sort(
    (a, b) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2],
  )[versions.length - 1];

  if (kind === "major") return `${major + 1}.0.0`;
  if (kind === "minor") return `${major}.${minor + 1}.0`;
  return `${major}.${minor}.${patch + 1}`;
}

function main() {
  const args = process.argv.slice(2);
  const bump = args.includes("--bump") ? (args[args.indexOf("--bump") + 1] ?? "") : "patch";
  const apply = args.includes("--apply");
  const dryRun = args.includes("--dry-run");

  if (!KINDS.includes(bump)) {
    console.error(`version: --bump must be one of ${KINDS.join(", ")}`);
    process.exit(2);
  }

  const tags = execFileSync("git", ["tag", "--list", "v[0-9]*"], { encoding: "utf8" })
    .split("\n")
    .filter(Boolean);
  const tag = `v${nextVersion(tags, bump)}`;

  if (tags.includes(tag)) {
    // Unreachable while `nextVersion` is correct. It stays because a tag that already exists
    // makes `--apply` a silent no-op, and the workflow would then release nothing.
    console.error(`version: ${tag} already exists`);
    process.exit(1);
  }

  if (!apply || dryRun) {
    console.log(tag);
    return;
  }

  const dirty = execFileSync("git", ["status", "--porcelain"], { encoding: "utf8" }).trim();
  if (dirty) {
    console.error("version: refusing to tag a dirty tree");
    process.exit(1);
  }

  execFileSync(
    "git",
    [
      "-c", "user.name=crucible-release",
      "-c", "user.email=release@users.noreply.github.com",
      "tag", "-a", tag, "-m", `Release ${tag}`,
    ],
    { stdio: "inherit" },
  );
  console.log(tag);
}

const invoked = (process.argv[1] ?? "").replace(/\\/g, "/");
if (invoked.endsWith("/scripts/version.mjs") || invoked.endsWith("version.mjs")) main();
