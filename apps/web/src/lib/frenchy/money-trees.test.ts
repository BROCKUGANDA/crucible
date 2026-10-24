import { describe, expect, it } from "vitest";
import { readdirSync, statSync, readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Gate 438 — No audio assets, no player code, no bundle weight.
 *
 * Money Trees is deep-link only (gate 434), and Frenchy v2 quips are text-only
 * (gate 674). This test enforces that the frenchy v2 code adds:
 *  - zero audio files under apps/web/src/lib/frenchy/, and
 *  - no `<audio>` element or `new Audio(` in frenchy source.
 */

const AUDIO_EXTS = new Set([".mp3", ".wav", ".ogg", ".m4a", ".aac", ".flac", ".wma", ".opus"]);

const ROOT = join(process.cwd(), "apps/web/src/lib/frenchy");
const EXCLUDE_DIRS = new Set(["node_modules", ".next", "dist", ".git"]);

function collectFiles(dir: string, out: string[]): void {
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
        if (!EXCLUDE_DIRS.has(entry)) collectFiles(full, out);
      } else {
        out.push(full);
      }
    } catch {
      /* skip unreadable */
    }
  }
}

function hasAudioExt(path: string): boolean {
  const ext = path.slice(path.lastIndexOf(".")).toLowerCase();
  return AUDIO_EXTS.has(ext);
}

describe("Gate 438 — no audio assets in repo", () => {
  it("no audio files under apps/web/src/lib/frenchy", () => {
    const files: string[] = [];
    collectFiles(ROOT, files);
    const audio = files.filter((f) => hasAudioExt(f));
    expect(audio).toEqual([]);
  });

  it("no <audio> element or new Audio( in frenchy source", () => {
    const files: string[] = [];
    collectFiles(ROOT, files);
    const srcFiles = files.filter((f) => f.endsWith(".ts") || f.endsWith(".tsx") || f.endsWith(".js"));
    let found = false;
    for (const f of srcFiles) {
      const content = readFileSync(f, "utf8");
      if (/<audio\b|new\s+Audio\s*\(/.test(content)) {
        found = true;
        console.error(`[gate 438] audio player found in ${f}`);
      }
    }
    expect(found).toBe(false);
  });
});
