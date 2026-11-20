/**
 * @file api-contract.test.ts — the contract cannot drift from the code.
 *
 * The developer portal serves `/v1/contract`, and that document claims to
 * describe the API. This test is what makes the claim true:
 *
 *   - every `code:` emitted by a route has an entry in the catalogue;
 *   - no catalogue entry names a code the API never emits (a documented code
 *     that does not exist is worse than an undocumented one, because a
 *     client will handle it);
 *   - the pagination limit the contract documents is the limit the
 *     paginator enforces;
 *   - the rate limit the contract documents is the limit the app installs.
 *
 * The scan reads the SOURCE, not the running server, on purpose: a code
 * behind a flag, a code in a branch no test exercises, is still a code a
 * caller can receive.
 */

import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { ERROR_CATALOGUE, DEFAULT_RATE_LIMIT, buildApiContract } from "../src/api-contract.js";
import { MAX_PAGE } from "../src/pagination.js";

const HERE = fileURLToPath(new URL(".", import.meta.url));
const SRC = join(HERE, "..", "src");

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      out.push(...sourceFiles(full));
    } else if (entry.endsWith(".ts") && !entry.endsWith(".d.ts")) {
      out.push(full);
    }
  }
  return out;
}

/** Every `code: "..."` the API's source emits, with the file it came from. */
function emittedCodes(): Map<string, string[]> {
  const found = new Map<string, string[]>();
  for (const file of sourceFiles(SRC)) {
    const text = readFileSync(file, "utf-8");
    const pattern = /code:\s*"([a-zA-Z0-9_-]+)"/g;
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(text)) !== null) {
      const code = match[1];
      const where = relative(join(HERE, ".."), file);
      const list = found.get(code) ?? [];
      list.push(where);
      found.set(code, list);
    }
  }
  return found;
}

describe("the API contract", () => {
  it("documents every error code the API emits", () => {
    const documented = new Set(ERROR_CATALOGUE.map((entry) => entry.code));
    const undocumented: string[] = [];

    for (const [code, files] of emittedCodes()) {
      if (!documented.has(code)) {
        undocumented.push(`${code} (${[...new Set(files)].join(", ")})`);
      }
    }

    expect(undocumented).toEqual([]);
  });

  it("documents no error code the API never emits", () => {
    const emitted = emittedCodes();
    const phantom = ERROR_CATALOGUE.filter((entry) => !emitted.has(entry.code)).map(
      (entry) => entry.code,
    );

    expect(phantom).toEqual([]);
  });

  it("gives every code a status between 400 and 599", () => {
    for (const entry of ERROR_CATALOGUE) {
      expect(entry.status).toBeGreaterThanOrEqual(400);
      expect(entry.status).toBeLessThan(600);
      expect(entry.meaning.length).toBeGreaterThan(10);
      expect(entry.whatToDo.length).toBeGreaterThan(10);
    }
  });

  it("documents the pagination limit the paginator enforces", () => {
    const contract = buildApiContract(() => 0);
    expect(contract.pagination.maxPage).toBe(MAX_PAGE);
  });

  it("documents the rate limit the app installs", () => {
    const contract = buildApiContract(() => 0);
    expect(contract.rateLimit.limit).toBe(DEFAULT_RATE_LIMIT.limit);
    expect(contract.rateLimit.perMs).toBe(DEFAULT_RATE_LIMIT.windowMs);
    expect(contract.rateLimit.burst).toBe(DEFAULT_RATE_LIMIT.burst);
  });

  it("describes every scheme the API accepts", () => {
    const contract = buildApiContract(() => 0);
    const names = contract.authentication.schemes.map((scheme) => scheme.name);
    expect(names).toContain("SIWE");
    expect(names).toContain("Organisation API key");
  });

  it("gives every error code a distinct meaning", () => {
    const meanings = ERROR_CATALOGUE.map((entry) => entry.meaning);
    expect(new Set(meanings).size).toBe(meanings.length);
  });
});
