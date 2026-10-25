#!/usr/bin/env node
/**
 * Gate 502 — the CI half of the sandbox seal.
 *
 * Scans the **agent-side** module graph — the files whose code an agent actually runs inside —
 * for imports the sandbox forbids: fs, child_process, net, wallet libraries. The scanner itself
 * lives in `src/import-lint.ts` and is the only file exempt; it must read the tree to police it.
 *
 * **This used to scan `packages/harness/src`, which was a prototype.** That package was deleted:
 * its `SandboxSupervisor` was a process-boundary simulation of a sandbox production already
 * implements for real (`forge-runner/src/sandbox.ts` runs a Docker container with `--network=none`),
 * and it had zero production importers. A gate that scans the wrong tree is decoration — it can go
 * green while the code that matters grows an `fs` import.
 *
 * The scope below is the agent's own modules in this package. The other side of the seal —
 * `packages/agent-security` — legitimately holds `node:crypto` and the executor's own powers,
 * because the executor is the party that *does* the effect; the agent proposes, the keeper does.
 *
 * The scanner is imported from `dist/`, the built artifact, so CI lints the same code it ships
 * rather than a parallel reimplementation. Run `npm run build -w @crucible/forge-runner` first
 * if this complains the module is missing.
 */

import { exit } from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));

let scanFile;
try {
  ({ scanFile } = await import(pathToFileURL(join(here, "..", "dist", "import-lint.js"))));
} catch {
  console.error(
    "import-lint: cannot load the scanner from packages/forge-runner/dist — build first with `npm run build -w @crucible/forge-runner`",
  );
  exit(2);
}

/** The agent-side modules. A new one must be added here deliberately, not by accident. */
const AGENT_SIDE = ["agent.ts", "providers.ts", "egress.ts", "tool-guard.ts"];

const target = join(here, "..", "src");
let failed = false;

for (const name of AGENT_SIDE) {
  const path = join(target, name);
  const result = scanFile(path);
  if (result.clean) continue;
  failed = true;
  console.error(`import-lint: src/${name} imports banned module(s): ${result.banned.join(", ")}`);
}

if (!failed) {
  console.log(
    `import-lint: ${AGENT_SIDE.length} agent-side modules in ${target} are clean — no banned module in the agent module graph (gate 502)`,
  );
  exit(0);
}

console.error(
  "import-lint: the agent module graph must not reach fs, child_process, net or any wallet library — agents propose, the keeper does.",
);
exit(1);
