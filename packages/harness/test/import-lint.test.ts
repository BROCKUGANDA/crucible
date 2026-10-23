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
});
