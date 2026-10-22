import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parseForgeTests } from "../src/artifact.js";

/**
 * Parsed against output a real forge produced, not against a shape we imagined.
 *
 * The fixture in `fixtures/forge-1.8.5.json` is `forge test --json` run against
 * `fixtures/trials/counter` on the version this repository pins, byte for byte. That matters
 * because the parser's own unit tests fed it a flattened `{ tests: [...] }` document that
 * this forge never emits: every assertion passed, and the deterministic re-run the parser
 * feeds would have abstained on every real run — an "unrecognised shape" error read as
 * "the suite cannot decide".
 *
 * A verifier that abstains on everything is not conservative, it is absent.
 */
describe("forge test --json, as produced", () => {
  const real = readFileSync(
    fileURLToPath(new URL("./fixtures/forge-1.8.5.json", import.meta.url)),
    "utf8",
  );

  it("reads the suite-keyed shape the pinned forge prints", () => {
    const results = parseForgeTests(real);
    expect(results.map((r) => r.name).sort()).toEqual(["test_increment_never_wraps()", "test_set_number()"]);
    expect(results.every((r) => r.status === "pass")).toBe(true);
  });

  it("keeps the two older shapes working, because a node may report either", () => {
    expect(parseForgeTests('{"tests":[{"name":"a","status":"PASS"}]}')[0].name).toBe("a");
    expect(parseForgeTests('{"test_results":{"b()":{"status":"Success"}}}')[0].name).toBe("b()");
  });

  it("still refuses a document with no tests in it at all", () => {
    expect(() => parseForgeTests('{"logs":[]}')).toThrow(/unrecognised forge test JSON shape/);
    expect(() => parseForgeTests('{"a:S":{"test_results":{}}}')).toThrow(/zero tests/);
  });
});
