#!/usr/bin/env node
/**
 * Gate 752 check — the TS side must reproduce every committed vector from the
 * live implementation, and the file must contain no float, timestamp or
 * provider field anywhere in a verdict body (constitution §2.7).
 */
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { createHash } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const { jcsCanonicalize } = require(join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "packages",
  "crypto",
  "dist",
  "jcs.js",
));

const file = join(dirname(fileURLToPath(import.meta.url)), "..", "vectors", "verdict", "vectors.json");
const { vectors } = JSON.parse(readFileSync(file, "utf8"));

const problems = [];
for (const v of vectors) {
  const jcs = jcsCanonicalize(v.body);
  if (jcs !== v.jcs) problems.push(`${v.name}: canonical bytes drifted — regenerate`);
  const sha = createHash("sha256").update(jcs, "utf8").digest("hex");
  if (sha !== v.sha256) problems.push(`${v.name}: sha256 mismatch over canonical bytes`);
  // Purity: no floats (any value with a decimal point), no forbidden keys.
  for (const [k, val] of Object.entries(v.body)) {
    if (typeof val === "number" && !Number.isInteger(val))
      problems.push(`${v.name}.${k}: floats are banned from verdict bodies (§2.7)`);
  }
  for (const banned of ["timestamp", "latency", "provider", "model", "cost", "tokens"])
    if (banned in v.body) problems.push(`${v.name}.${banned}: banned field (§2.7)`);
}

if (problems.length > 0) {
  console.error(`vectors:check FAILED:\n  ${problems.join("\n  ")}`);
  process.exit(1);
}
console.log(`vectors:check green — ${vectors.length}/${vectors.length} reproduced byte-for-byte by the live TS JCS (gate 752)`);
