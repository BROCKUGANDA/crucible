/**
 * Gate 502 — CI enforcement of the sandbox seal.
 *
 * Import-graph lint: no `fs` / `child_process` / `net` / `viem-wallet` in the
 * harness module graph. This tool is the enforcer (it may use node:fs itself);
 * the code it scans must not.
 */

import { readdirSync, statSync, readFileSync } from "node:fs";
import { join, extname, relative } from "node:path";

/** Modules banned from the agent/harness import graph (gate 493 no-key law). */
export const BANNED_IMPORTS = [
  "fs",
  "child_process",
  "net",
  "tls",
  "crypto",
  "viem",
  "ethers",
  "@noble/curves",
  "@noble/hashes",
];

const SOURCE_EXTS = new Set([".ts", ".tsx", ".js", ".mjs"]);

// Static `from`/`require` and dynamic `import()` — a dynamic import of `fs` is the same
// escape hatch with one more token in front of it.
const importRegex =
  /from\s+["']([^"']+)["']|require\s*\(\s*["']([^"']+)["']\s*\)|import\s*\(\s*["']([^"']+)["']\s*\)/g;

/** `node:fs` is `fs`; the ban list names modules, not spellings. */
function normalizeSpecifier(mod: string): string {
  return mod.startsWith("node:") ? mod.slice("node:".length) : mod;
}

/** Scan a single source file for banned imports. */
export function scanFile(filePath: string): { banned: string[]; clean: boolean } {
  let source = "";
  try {
    source = readFileSync(filePath, "utf8");
  } catch {
    return { banned: [], clean: true };
  }

  const banned: string[] = [];
  for (const match of source.matchAll(importRegex)) {
    const mod = normalizeSpecifier(match[1] ?? match[2] ?? match[3] ?? "");
    if (mod && BANNED_IMPORTS.some((b) => mod === b || mod.startsWith(b + "/"))) {
      banned.push(mod);
    }
  }

  return { banned, clean: banned.length === 0 };
}

/**
 * Recursively scan a directory for banned imports in source files.
 *
 * Reported `path`s are relative to the scanned directory with `/` separators, and
 * `options.exempt` names files the gate may not flag in that same form. The only
 * legitimate entry is the enforcer itself, which must read the tree to police it;
 * anything else on that list is a hole and should not pass review.
 */
export function scanDirectory(
  dirPath: string,
  options: { exempt?: readonly string[] } = {},
): {
  files: Array<{ path: string; banned: string[] }>;
  allClean: boolean;
} {
  const exempt = new Set(options.exempt ?? []);
  const files: Array<{ path: string; banned: string[] }> = [];
  let allClean = true;

  function walk(dir: string): void {
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = join(dir, entry);
      try {
        if (statSync(full).isDirectory()) {
          if (entry !== "node_modules" && entry !== "dist" && entry !== ".git") {
            walk(full);
          }
        } else if (SOURCE_EXTS.has(extname(full))) {
          const result = scanFile(full);
          if (!result.clean) {
            files.push({
              path: relative(dirPath, full).replaceAll("\\", "/"),
              banned: result.banned,
            });
            allClean = false;
          }
        }
      } catch {
        // skip unreadable files
      }
    }
  }

  walk(dirPath);
  const kept = files.filter((f) => !exempt.has(f.path));
  return { files: kept, allClean: kept.length === 0 };
}
