#!/usr/bin/env node
/**
 * Gate 702 — compile-time CPI allowlist.
 *
 * The program may CPI only through anchor-spl (SPL Token + System). This check
 * enforces the two things that guarantee it at the source level:
 *   1. the program crate's dependencies are exactly {anchor-lang, anchor-spl}
 *      (plus the workspace glue) — no other program crates can be reached;
 *   2. no direct solana_program::invoke / invoke_signed call sites, which
 *      would bypass anchor's CPI surface entirely.
 *
 * A fifth dependency or a raw invoke is a red build, not a review note.
 *
 * Scope is per program, and it has to be. This is `work-escrow`'s law (v1, gate 702). A
 * second crate in this workspace — the v2 arena — is designed around the Ed25519 precompile
 * read through the Instructions sysvar, which needs a dependency and a call shape this rule
 * forbids by construction. Inheriting v1's allowlist would not protect anything; it would
 * only decide the outcome of a program that has not been written yet.
 *
 * So a program that is not named below is REPORTED, not passed. An unmeasured program printing
 * a note is a known gap; an unmeasured program printing nothing is the failure this gate
 * exists to prevent.
 */
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const programsRoot = join(here, "..", "programs");

/** Program name -> the CPI policy enforced on it. Add a program by name, with its own law. */
const PROGRAM_POLICY = {
  "work-escrow": {
    deps: new Set(["anchor-lang", "anchor-spl"]),
    rawInvokeAllowed: false,
  },
};

const problems = [];
const uncovered = [];

for (const entry of readdirSync(programsRoot, { withFileTypes: true })) {
  if (!entry.isDirectory()) continue;
  const manifest = join(programsRoot, entry.name, "Cargo.toml");
  if (!existsSync(manifest)) continue;

  const policy = PROGRAM_POLICY[entry.name];
  if (!policy) {
    uncovered.push(entry.name);
    continue;
  }

  const text = readFileSync(manifest, "utf8");
  const depsBlock = text.split("[dependencies]")[1]?.split("\n[")[0] ?? "";
  for (const line of depsBlock.split("\n")) {
    const name = line.trim().split("=")[0]?.trim();
    if (!name || name.startsWith("#")) continue;
    if (!policy.deps.has(name)) {
      problems.push(`${entry.name}: dependency "${name}" is not on ${entry.name}'s CPI allowlist`);
    }
  }

  const srcDir = join(programsRoot, entry.name, "src");
  if (!policy.rawInvokeAllowed && existsSync(srcDir)) {
    const walk = (dir) => {
      for (const f of readdirSync(dir, { withFileTypes: true })) {
        const full = join(dir, f.name);
        if (f.isDirectory()) walk(full);
        else if (f.name.endsWith(".rs")) {
          const rs = readFileSync(full, "utf8");
          // `invoke_signed?` is not `invoke` or `invoke_signed` — the ? binds to the `d` only,
          // so the spelling that bypasses anchor-spl most directly used to slip through here.
          const raw = /invoke(?:_signed)?\s*\(/.exec(rs);
          if (raw) {
            problems.push(`${entry.name}/src: raw ${raw[0]} call in ${full} — ${entry.name}'s policy forbids CPI outside anchor-spl`);
          }
        }
      }
    };
    walk(srcDir);
  }
}

if (problems.length > 0) {
  console.error(`CPI allowlist FAILED:\n  ${problems.join("\n  ")}`);
  process.exit(1);
}

for (const name of uncovered) {
  console.warn(`CPI allowlist: programs/${name} is in the workspace but names no policy — gate 702 does NOT cover it. Add it to PROGRAM_POLICY with its own law.`);
}
console.log(
  `CPI allowlist: ${Object.keys(PROGRAM_POLICY).length} program(s) enforced (${Object.keys(PROGRAM_POLICY).join(", ")}) — anchor deps only, no raw invoke. Gate 702.`,
);
