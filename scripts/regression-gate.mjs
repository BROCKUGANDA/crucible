#!/usr/bin/env node
/**
 * Regression gate: runs the key test suites to ensure nothing broke.
 * Usage: node scripts/regression-gate.mjs
 */
import { execSync } from "node:child_process";
import path from "node:path";

const ROOT = process.cwd();
let fail = 0;

function run(label, cmd) {
  console.log(`\n== ${label} ==`);
  try {
    execSync(cmd, { cwd: ROOT, stdio: "inherit", timeout: 300000 });
    console.log(`  ok    ${label}`);
  } catch (e) {
    console.log(`  FAIL  ${label}`);
    fail = 1;
  }
}

run("params:check (gate 732)", "node scripts/params-codegen.mjs --check");
run("workspace coverage (gate 731)", "node scripts/workspace-coverage-gate.mjs .github/workflows/ci.yml");
run("drift gate (gates 725/753/801)", "node scripts/drift-gate.mjs");
run("arena-events tests", "npm test --workspace @crucible/arena-events");
run("frame tests", "npm test --workspace @crucible/frame");
run("api tests", "npm test --workspace @crucible/api");

console.log(`\n== summary ==`);
if (fail === 0) {
  console.log("REGRESSION GATE GREEN — all checks passed.");
} else {
  console.log("REGRESSION GATE RED — see failures above.");
  process.exit(1);
}
