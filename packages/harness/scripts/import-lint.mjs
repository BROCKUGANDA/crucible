#!/usr/bin/env node
/**
 * Gate 502 — the CI half of the sandbox seal.
 *
 * Scans the harness module graph (this package's `src/`) for imports the sandbox
 * forbids: fs, child_process, net, wallet libraries. The scanner itself lives in
 * `src/import-lint.ts` and is the only file exempt — it must read the tree to police
 * it, which its header says in so many words.
 *
 * The scanner is imported from `dist/`, the built artifact, so CI lints the same code
 * it ships rather than a parallel reimplementation. Run `npm run build -w @crucible/harness`
 * first if this complains the module is missing.
 */

import { exit } from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));

let scanDirectory;
try {
  ({ scanDirectory } = await import(pathToFileURL(join(here, "..", "dist", "import-lint.js"))));
} catch {
  console.error(
    "import-lint: cannot load the scanner from packages/harness/dist — build first with `npm run build -w @crucible/harness`",
  );
  exit(2);
}

const target = join(here, "..", "src");
const result = scanDirectory(target, { exempt: ["import-lint.ts"] });

if (result.allClean) {
  console.log(
    `import-lint: ${target} is clean — no banned module in the harness module graph (gate 502)`,
  );
  exit(0);
}

for (const file of result.files) {
  console.error(`import-lint: ${file.path} imports banned module(s): ${file.banned.join(", ")}`);
}
console.error(
  "import-lint: the harness module graph must not reach fs, child_process, net or any wallet library — agents propose, the keeper does.",
);
exit(1);
