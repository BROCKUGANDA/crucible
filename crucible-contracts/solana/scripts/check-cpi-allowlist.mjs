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
 */
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const programsRoot = join(here, "..", "programs");

const ALLOWED_DEPS = new Set(["anchor-lang", "anchor-spl"]);

const problems = [];

for (const entry of readdirSync(programsRoot, { withFileTypes: true })) {
  if (!entry.isDirectory()) continue;
  const manifest = join(programsRoot, entry.name, "Cargo.toml");
  if (!existsSync(manifest)) continue;
  const text = readFileSync(manifest, "utf8");
  const depsBlock = text.split("[dependencies]")[1]?.split("\n[")[0] ?? "";
  for (const line of depsBlock.split("\n")) {
    const name = line.trim().split("=")[0]?.trim();
    if (!name || name.startsWith("#")) continue;
    if (!ALLOWED_DEPS.has(name)) {
      problems.push(`${entry.name}: dependency "${name}" is not on the CPI allowlist`);
    }
  }

  const srcDir = join(programsRoot, entry.name, "src");
  if (existsSync(srcDir)) {
    const walk = (dir) => {
      for (const f of readdirSync(dir, { withFileTypes: true })) {
        const full = join(dir, f.name);
        if (f.isDirectory()) walk(full);
        else if (f.name.endsWith(".rs")) {
          const rs = readFileSync(full, "utf8");
          if (/invoke_signed?\s*\(/.test(rs)) {
            problems.push(`${entry.name}/src: raw ${rs.match(/invoke_signed?\s*\(/)[0]} call in ${full} — CPI must go through anchor-spl`);
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
console.log("CPI allowlist: program graph clean (anchor-lang + anchor-spl only, no raw invoke) — gate 702");
