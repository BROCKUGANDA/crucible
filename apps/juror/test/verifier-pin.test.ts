import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// P0-7: the verifier-image pin must survive the live-trial boundary. The
// LiveVerifier's own default resolves CRUCIBLE_VERIFIER_IMAGE (a digest pin);
// the seat used to override it with the raw mutable spec, so the one
// production verifier re-ran suites on `crucible/verifier:latest`.
// Wiring is asserted from source because main.ts starts the service on import.
describe("juror verifier pin", () => {
  it("the seat resolves the digest-pinned verifier image instead of the mutable default", () => {
    const main = readFileSync(new URL("../src/main.ts", import.meta.url), "utf8");
    expect(main).toContain("resolveVerifierImage");
    expect(main).not.toContain("sandboxSpec: DEFAULT_SANDBOX");
  });
});
