import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Every `NEXT_PUBLIC_*` a compose overlay passes must reach the Next build.
 *
 * `NEXT_PUBLIC_*` values are inlined into the browser bundle at build time, so a
 * build arg the Dockerfile does not declare is not "unused" — it is a setting
 * that silently never arrives. That was true of `NEXT_PUBLIC_ALLOWED_CHAINS`:
 * `compose.public-demo.yaml` passed `foundry`, and the demo image still offered
 * Mainnet and Sepolia as writable networks, because the variable never entered
 * the build.
 *
 * The check reads the overlay file that actually runs (`compose.public-demo.yaml`
 * is the Stage A deployment in the runbook) and the Dockerfile that actually
 * builds, and compares the two. It would have been red before the fix.
 */

const ROOT = join(__dirname, "..", "..", "..");
const DOCKERFILE = readFileSync(join(ROOT, "apps", "web", "Dockerfile"), "utf8");

function buildArgsPassedBy(overlay: string): string[] {
  const text = readFileSync(join(ROOT, overlay), "utf8");
  const names = new Set<string>();
  for (const match of text.matchAll(/^\s+(NEXT_PUBLIC_[A-Z0-9_]+):/gm)) {
    names.add(match[1]!);
  }
  return [...names].sort();
}

describe("the web image accepts every public build arg its overlay passes", () => {
  it("reads a non-empty list from the public-demo overlay", () => {
    // A regex that matched nothing would make the next test vacuously green.
    expect(buildArgsPassedBy("compose.public-demo.yaml").length).toBeGreaterThan(0);
  });

  it("declares each overlay arg as ARG and forwards it in ENV", () => {
    for (const overlay of ["compose.public-demo.yaml"]) {
      for (const name of buildArgsPassedBy(overlay)) {
        expect(DOCKERFILE, `${overlay}: ${name} is not declared`).toMatch(
          new RegExp(`^ARG ${name}$`, "m"),
        );
        expect(DOCKERFILE, `${overlay}: ${name} is declared but not exported`).toMatch(
          new RegExp(`${name}="\\$${name}"`),
        );
      }
    }
  });

  it("keeps the chain allowlist among them", () => {
    // Named explicitly because its absence is the bug this test exists for.
    expect(buildArgsPassedBy("compose.public-demo.yaml")).toContain("NEXT_PUBLIC_ALLOWED_CHAINS");
  });

  it("passes the optional Web3Auth client id through the deployment compose file", () => {
    const name = "NEXT_PUBLIC_WEB3AUTH_CLIENT_ID";
    expect(buildArgsPassedBy("compose.yaml")).toContain(name);
    expect(DOCKERFILE).toMatch(new RegExp(`^ARG ${name}$`, "m"));
    expect(DOCKERFILE).toMatch(new RegExp(`${name}="\\$${name}"`));
  });
});
