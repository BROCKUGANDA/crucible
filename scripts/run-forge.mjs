#!/usr/bin/env node
/**
 * Run Foundry without requiring it on PATH.
 *
 * `npm test` at the root invokes the contracts workspace, and on Windows a Foundry
 * install commonly lives at %USERPROFILE%\.foundry\bin but is missing from the PATH an
 * npm child process inherits. That made the one-command verification path fail on an
 * otherwise healthy checkout. This wrapper resolves the binary explicitly and then
 * execs it with the arguments it was given.
 */
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const args = process.argv.slice(2);

function candidates() {
  const names = process.platform === "win32" ? ["forge.exe", "forge"] : ["forge"];
  const roots = [
    process.env.FOUNDRY_BIN,
    join(homedir(), ".foundry", "bin"),
  ].filter(Boolean);
  return names.flatMap((name) => roots.map((root) => join(root, name)));
}

function probe(command) {
  const result = spawnSync(command, ["--version"], { stdio: "ignore" });
  return result.status === 0;
}

let forge = null;
if (probe("forge")) {
  forge = "forge";
} else {
  forge = candidates().find((candidate) => existsSync(candidate) && probe(candidate)) ?? null;
}

if (!forge) {
  console.error(
    "forge not found. Install Foundry (https://book.getfoundry.sh/getting-started/installation)\n" +
      "or set FOUNDRY_BIN to the directory that contains it.",
  );
  process.exit(1);
}

const result = spawnSync(forge, args, { stdio: "inherit" });
if (result.error) {
  console.error(result.error.message);
  process.exit(1);
}
process.exit(result.status ?? 1);
