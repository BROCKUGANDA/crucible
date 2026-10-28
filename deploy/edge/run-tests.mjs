// test:edge runner.
//
// `node --test "deploy/edge/**/*.test.mjs"` was green on a laptop and red in CI, because glob
// patterns in `--test` paths arrived after the Node 20 that the gate pins — which read the pattern
// as a filename and stopped with "Could not find .../deploy/edge/**/*.test.mjs". A bare directory
// argument is the other half: Node 20 searches it recursively, newer runtimes treat it as a failed
// glob. So discovery happens here and the files are handed over explicitly, on every version.
//
// The zero-file refusal is the point rather than a nicety. An edge suite that walks nothing
// reports success over an empty set, which is the failure this repository has been caught in twice
// (gate 438's scan root, and `gate.test.mjs` sitting green while nothing ran it).
import { readdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(fileURLToPath(import.meta.url));

function collect(dir, out) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) collect(full, out);
    else if (entry.name.endsWith(".test.mjs")) out.push(full);
  }
  return out;
}

const files = collect(root, []).sort();
if (files.length === 0) {
  console.error(`edge: no *.test.mjs under ${root} — a suite that walks zero files proves nothing`);
  process.exit(1);
}

console.log(`edge: ${files.length} test files, node ${process.version}`);
const result = spawnSync(process.execPath, ["--test", ...files], { stdio: "inherit" });
process.exit(result.status ?? 1);
