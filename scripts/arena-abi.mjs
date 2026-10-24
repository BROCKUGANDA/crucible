#!/usr/bin/env node
/**
 * Generate `packages/smith-sdk/src/arena-abi.ts` from the compiled Arena artifact.
 *
 * The other two ABIs in the SDK are hand-written and drift-checked against the `.sol` source
 * (test/abi-drift.test.ts). Arena has 50 functions, 23 events and 54 errors — hand-typing that
 * is a transcription exercise with no upside, so this one is generated from the artifact the
 * compiler produced and the same drift test still checks its events against the source.
 *
 * Run from the repository root, after `forge build` in crucible-contracts:
 *   node scripts/arena-abi.mjs
 *
 * `--check` regenerates in memory and compares against the committed file, exiting 1 on drift.
 * It needs the artifact, so it is a local/pre-push check rather than a CI job (the JS job in
 * ci.yml never builds the contracts).
 */
import { readFileSync, writeFileSync } from "node:fs";

const ARTIFACT = "crucible-contracts/out/Arena.sol/Arena.json";
const OUT = "packages/smith-sdk/src/arena-abi.ts";

const art = JSON.parse(readFileSync(ARTIFACT, "utf8"));
if (!Array.isArray(art.abi)) throw new Error(`${ARTIFACT} has no abi array`);

const counts = art.abi.reduce((acc, e) => ((acc[e.type] = (acc[e.type] ?? 0) + 1), acc), {});
if (!counts.function || !counts.event) throw new Error(`unexpected ABI shape: ${JSON.stringify(counts)}`);

const body = JSON.stringify(art.abi, null, 2);

const file = `/**
 * Arena's ABI — GENERATED, do not edit by hand.
 *
 * Source: \`crucible-contracts/out/Arena.sol/Arena.json\` (solc ${art.metadata?.compiler?.version ?? "unknown"}).
 * Regenerate with \`node scripts/arena-abi.mjs\` after any change to \`contracts/Arena.sol\`.
 *
 * Generated rather than hand-written because there are ${counts.function} functions, ${counts.event} events and
 * ${counts.error} errors; a hand-typed copy of that is a transcription bug waiting for a chain to decode it
 * wrongly. \`packages/smith-sdk/test/abi-drift.test.ts\` still compares the EVENTS to the Solidity
 * source, which is the part whose parameter order changes topic0.
 */
export const ARENA_ABI = ${body} as const;
`;

if (process.argv.includes("--check")) {
  const current = readFileSync(OUT, "utf8");
  if (current !== file) {
    console.error(`${OUT} is stale: re-run \`node scripts/arena-abi.mjs\``);
    process.exit(1);
  }
  console.log(`${OUT} matches the artifact (${counts.function} functions, ${counts.event} events, ${counts.error} errors)`);
} else {
  writeFileSync(OUT, file);
  console.log(`wrote ${OUT}: ${counts.function} functions, ${counts.event} events, ${counts.error} errors`);
}
