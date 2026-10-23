/**
 * Gate 502 — CI enforcement of the sandbox seal.
 *
 * Import-graph lint: no `fs` / `child_process` / `net` / `viem-wallet` in the
 * harness module graph. This tool is the enforcer (it may use node:fs itself);
 * the code it scans must not.
 */

import { readdirSync, statSync, readFileSync } from "node:fs";
import { join, extname } from "node:path";

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

const importRegex = /from\s+["']([^"']+)["']|require\s*\(\s*["']([^"']+)["']\s*\)/g;

/** Scan a single source file for banned imports. */
export function scanFile(filePath: string): { banned: string[]; clean: boolean } {
  let source = "";
  try {
    source = readFileSync(filePath, "utf8");
  } catch {
    return { banned: [], clean: true };
  }

  const banned: string[] = [];
  let match: RegExpExecArray | null;
  while ((match = importRegex.exec(source)) !== null) {
    const mod = match[1] ?? match[2];
    if (mod && BANNED_IMPORTS.some((b) => mod === b || mod.startsWith(b + "/"))) {
      banned.push(mod);
    }
  }

  return { banned, clean: banned.length === 0 };
}

/** Recursively scan a directory for banned imports in source files. */
export function scanDirectory(dirPath: string): {
  files: Array<{ path: string; banned: string[] }>;
  allClean: boolean;
} {
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
            files.push({ path: full, banned: result.banned });
            allClean = false;
          }
        }
      } catch {
        // skip unreadable files
      }
    }
  }

  walk(dirPath);
  return { files, allClean };
}
