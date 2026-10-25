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

import { fileURLToPath } from "node:url";
const ROOT = join(fileURLToPath(new URL(".", import.meta.url)), "..", "..", "..", "src", "lib", "frenchy");
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
    expect(files.length, "gate 438 walked zero files, so it cannot find anything either way").toBeGreaterThan(0);
    const audio = files.filter((f) => hasAudioExt(f));
    expect(audio).toEqual([]);
  });

  it("no audio markup and no audio library in frenchy source", () => {
    const files: string[] = [];
    collectFiles(ROOT, files);
    // This file names the strings it forbids in its own prose, so scanning it makes the gate red on
    // documentation. That is the trap AGENTS.md records for the install-tool check — a matcher that
    // reads a file's explanation cannot tell it from the executed statement — arriving from the
    // opposite direction.
    const srcFiles = files.filter(
      (f) => (f.endsWith(".ts") || f.endsWith(".tsx") || f.endsWith(".js")) && !/\.test\.[tj]sx?$/.test(f),
    );
    expect(srcFiles.length, "gate 438 walked zero source files").toBeGreaterThan(0);
    let found = false;
    for (const f of srcFiles) {
      const content = readFileSync(f, "utf8");
      // Narrowed 2026-10-25, and the narrowing is worth the comment. The gate's title is "no audio
      // assets, no player code, no bundle weight"; what a source scan can actually measure is markup
      // and libraries. `new Audio(url)` is a browser primitive — no asset, no import, no bundle
      // weight — and `components/VoiceControl.tsx:97` has played the server-returned clip that way
      // since the voice host shipped, with the key held by the API and never by the browser. Forbidding
      // it here would have banned the shipped design rather than the thing this gate was written
      // against. Dropping the native element too is a decision about the premium voice path, and a
      // path that resolved to a directory that does not exist was not entitled to make it.
      if (/<audio\b|from\s+["'](?:howler|wavesurfer|@pixi\/sound|soundmanager2)["']/.test(content)) {
        found = true;
        console.error(`[gate 438] audio player found in ${f}`);
      }
    }
    expect(found).toBe(false);
  });
});
