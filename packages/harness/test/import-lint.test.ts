import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { scanFile, scanDirectory, BANNED_IMPORTS } from "../src/import-lint.js";
import { join } from "node:path";
import { writeFileSync, mkdirSync, rmSync } from "node:fs";
import { dirname } from "node:path";

const tmpDir = join(process.cwd(), "test", ".import-lint-tmp");

describe("Import-lint CI enforcement (gate 502)", () => {
  beforeEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
    mkdirSync(tmpDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("BANNED_IMPORTS contains the no-key law modules (gate 493)", () => {
    expect(BANNED_IMPORTS).toContain("fs");
    expect(BANNED_IMPORTS).toContain("viem");
    expect(BANNED_IMPORTS).toContain("ethers");
  });

  it("flags a file importing a banned module", () => {
    const file = join(tmpDir, "bad.ts");
    writeFileSync(file, "import { writeFileSync } from 'fs';");
    const result = scanFile(file);
    expect(result.clean).toBe(false);
    expect(result.banned).toContain("fs");
  });

  it("passes a file with no banned imports", () => {
    const file = join(tmpDir, "good.ts");
    writeFileSync(file, "export const x = 1;");
    const result = scanFile(file);
    expect(result.clean).toBe(true);
    expect(result.banned).toEqual([]);
  });

  it("scans a directory recursively", () => {
    const sub = join(tmpDir, "sub");
    mkdirSync(sub, { recursive: true });
    writeFileSync(join(tmpDir, "clean.ts"), "export const a = 1;");
    writeFileSync(join(sub, "dirty.ts"), "import { createHash } from 'crypto';");
    const result = scanDirectory(tmpDir);
    expect(result.allClean).toBe(false);
    expect(result.files.length).toBeGreaterThan(0);
    const dirty = result.files.find((f) => f.path.endsWith("dirty.ts"));
    expect(dirty?.banned).toContain("crypto");
  });

  // `node:fs` is `fs`. A lint that matches the bare name only would green-light the
  // prefix spelling, which is the same module with one token in front of it.
  it("flags the node: spelling of a banned module", () => {
    const file = join(tmpDir, "prefixed.ts");
    writeFileSync(file, "import { readFileSync } from 'node:fs';");
    const result = scanFile(file);
    expect(result.clean).toBe(false);
    expect(result.banned).toContain("fs");
  });

  it("flags a dynamic import of a banned module", () => {
    const file = join(tmpDir, "dynamic.ts");
    writeFileSync(file, "const m = await import('child_process');");
    const result = scanFile(file);
    expect(result.clean).toBe(false);
    expect(result.banned).toContain("child_process");
  });

  it("reports paths relative to the scanned directory", () => {
    const sub = join(tmpDir, "nested");
    mkdirSync(sub, { recursive: true });
    writeFileSync(join(sub, "dirty.ts"), "import fs from 'fs';");
    const result = scanDirectory(tmpDir);
    const dirty = result.files.find((f) => f.path === join("nested", "dirty.ts").replaceAll("\\", "/"));
    expect(dirty).toBeDefined();
  });

  it("exempt silences exactly the named file and nothing else", () => {
    mkdirSync(tmpDir, { recursive: true });
    writeFileSync(join(tmpDir, "enforcer.ts"), "import { readFileSync } from 'node:fs';");
    writeFileSync(join(tmpDir, "agent.ts"), "import { readFileSync } from 'node:fs';");

    const withoutExempt = scanDirectory(tmpDir);
    expect(withoutExempt.files).toHaveLength(2);

    const result = scanDirectory(tmpDir, { exempt: ["enforcer.ts"] });
    expect(result.files.map((f) => f.path)).toEqual(["agent.ts"]);
    expect(result.allClean).toBe(false);
  });
});
