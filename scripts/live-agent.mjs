#!/usr/bin/env node
/**
 * Run the real agent against a real model, in a real sandbox.
 *
 * Everything else in this repo proves the agent's *logic* against stubs. This is the one
 * script that answers the only question a stub cannot: does the prompt actually work?
 * A `SYSTEM_PROMPT` that has never seen a real response is a hypothesis.
 *
 * It does not touch a chain. The point is the work loop — fetch spec, ask the model for
 * a patch, apply it, run the pinned suite, feed the failure back — so it needs nothing
 * but an API key. That keeps it runnable in the thirty seconds before a demo.
 *
 *   ANTHROPIC_API_KEY=sk-ant-... node scripts/live-agent.mjs
 *
 * Options:
 *   --model <id>       default claude-sonnet-4-5
 *   --budget <n>       iterations, default 3
 *   --task <file>      a spec to solve, default the fixture below
 *   --keep             leave the sandbox on disk for inspection
 *   --dry              one model call, no work loop
 *
 * Exit code is 0 when the suite went green, 1 otherwise — so CI can gate on it.
 */

import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");

// ── args ─────────────────────────────────────────────────────────────────

function arg(name, fallback = null) {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? fallback : (process.argv[i + 1] ?? true);
}
const flag = (name) => process.argv.includes(`--${name}`);

const MODEL = String(arg("model", "claude-sonnet-4-5"));
const BUDGET = Number(arg("budget", "3"));
const DRY = flag("dry");
const KEEP = flag("keep");

// ── the task under test ──────────────────────────────────────────────────

/**
 * A deliberately small, real Solidity task: the pinned suite is red, the fix is a few
 * lines, and a wrong answer is immediately visible. If the agent cannot do *this*, it
 * will not do anything worth demoing.
 */
const FIXTURE_SPEC = `The contract src/Forge.sol declares a counter with an increment()
function that is supposed to increase \`total\` by one and emit a \`Counted\` event with
the new value. It currently does nothing.

Implement \`increment()\` so that:
- \`total\` increases by exactly 1
- a \`Counted\` event is emitted carrying the NEW total (after the increment)
- the function is callable by anyone

Do not change the event signature. Do not add new imports.`;

/** The pinned suite. Red until the agent fixes it — which is what makes this a test. */
const FIXTURE_SUITE = `// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "../src/Forge.sol";

contract ForgeTest {
    function test_startsAtZero() public {
        Forge f = new Forge();
        assert(f.total() == 0);
    }

    function test_incrementRaisesTotal() public {
        Forge f = new Forge();
        f.increment();
        assert(f.total() == 1, "total should be 1 after one increment");
    }

    function test_emitsCounted() public {
        Forge f = new Forge();
        // forge-std would be used here; this records the requirement plainly
        f.increment();
        assert(f.total() == 1);
    }
}
`;

const FIXTURE_SOURCE = `// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

contract Forge {
    uint256 public total;

    event Counted(uint256 newTotal);

    // TODO: increment total and emit Counted
    function increment() external {}
}
`;

// ── imports (dynamic, so the script reports a missing build clearly) ─────

async function loadForgeRunner() {
  const dist = path.join(ROOT, "packages/forge-runner/dist/index.js");
  if (!existsSync(dist)) {
    throw new Error(
      "forge-runner is not built. Run `npm run build` at the repo root first.",
    );
  }
  return import(dist);
}

// ── main ─────────────────────────────────────────────────────────────────

async function main() {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    console.error(
      "\n  ANTHROPIC_API_KEY is not set.\n\n" +
        "  This script calls a real model on purpose — the prompt has never been run\n" +
        "  against one, and an untested prompt is a demo-day surprise.\n\n" +
        "  PowerShell:\n" +
        "    $env:ANTHROPIC_API_KEY = 'sk-ant-...'; node scripts/live-agent.mjs\n",
    );
    process.exit(1);
  }

  const taskFile = arg("task");
  const spec = taskFile ? await readFile(String(taskFile), "utf8") : FIXTURE_SPEC;

  const { createForgedAgent, anthropicClient, Sandbox, touchesTests, filesTouched } =
    await loadForgeRunner();

  const client = anthropicClient({ apiKey, model: MODEL });
  const agent = createForgedAgent({
    client,
    model: MODEL,
    temperature: 0.2,
  });

  console.log(`\n  model    ${MODEL}`);
  console.log(`  budget   ${DRY ? "1 (dry)" : BUDGET}`);
  console.log(`  task     ${taskFile ?? "(built-in fixture)"}\n`);

  // Seed the sandbox so the model has something real to read and patch.
  const sandbox = new Sandbox();
  await sandbox.writeSpec(spec);
  await sandbox.writeFile("src/Forge.sol", FIXTURE_SOURCE);
  await sandbox.writeFile("test/Forge.t.sol", FIXTURE_SUITE);

  if (DRY) {
    const result = await agent.step({
      iteration: 1,
      brief: { trialId: 0, iterBudget: 1 },
      spec,
    });
    report("dry run — nothing applied", result);
    await finish(sandbox);
    return;
  }

  // The work loop. This mirrors runner.ts, but without the chain, the signing, and the
  // ceremony — the only parts that need more than an API key.
  let lastOutput = "";
  let patch = "";
  let notes = "";

  for (let iteration = 1; iteration <= BUDGET; iteration++) {
    process.stdout.write(`  iteration ${iteration}/${BUDGET} … `);

    const result = await agent.step({
      iteration,
      brief: { trialId: 0, iterBudget: BUDGET },
      spec,
      lastOutput,
    });
    patch = result.patch;
    notes = result.notes ?? "";

    if (!patch.trim()) {
      console.log(`no patch (${notes})`);
      break;
    }

    const touched = filesTouched(patch);

    // The invariant the runner enforces. Checking it here proves the *prompt* holds that
    // line without the runner's help, which is the stronger statement.
    if (touchesTests(patch)) {
      console.log("REJECTED — the model tried to edit the pinned tests");
      report(`iteration ${iteration}`, result);
      await finish(sandbox);
      process.exitCode = 1;
      return;
    }

    const applied = await sandbox.applyPatch(patch);
    if (!applied.ok) {
      console.log(`patch did not apply: ${applied.message}`);
      report(`iteration ${iteration}`, result);
      await finish(sandbox);
      process.exitCode = 1;
      return;
    }

    const suite = await sandbox.runSuite("forge test", 120).catch((err) => ({
      ok: false,
      stdout: "",
      stderr: String(err?.message ?? err),
      code: -1,
    }));

    lastOutput = `${suite.stdout ?? ""}\n${suite.stderr ?? ""}`;

    if (suite.ok) {
      console.log(`GREEN — ${touched.length} file(s): ${touched.join(", ")}`);
      console.log(`\n  ✓ the agent turned the suite green in ${iteration} iteration(s)`);
      await showPatch(sandbox, patch);
      await finish(sandbox);
      return;
    }

    console.log(`still red (${touched.join(", ")}) — feeding the failure back`);
  }

  console.log(`\n  ✗ the suite never went green in ${BUDGET} iteration(s).`);
  console.log(`    last: ${notes}`);
  await finish(sandbox);
  process.exitCode = 1;
}

function report(label, result) {
  console.log(`\n  ── ${label} ──`);
  console.log(`  notes: ${result.notes ?? "(none)"}`);
  console.log(`  done:  ${result.done}`);
  if (!result.patch?.trim()) {
    console.log("  patch: (empty)");
    return;
  }
  console.log("\n--- patch ---");
  console.log(result.patch);
  console.log("--- end patch ---\n");
}

/** Show the post-patch source, so the result is inspectable rather than implied. */
async function showPatch(sandbox, patch) {
  try {
    const source = await sandbox.readFile("src/Forge.sol");
    console.log("\n  src/Forge.sol after the patch:");
    for (const line of source.split("\n")) console.log(`    ${line}`);
  } catch {
    console.log("\n  (could not read the patched file back)");
  }
}

async function finish(sandbox) {
  if (KEEP) {
    console.log(`\n  sandbox kept for inspection`);
    return;
  }
  await sandbox.cleanup().catch(() => {});
}

main().catch((err) => {
  console.error("\n  live-agent failed:", err.message);
  process.exit(1);
});