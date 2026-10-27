import { describe, expect, it } from "vitest";
import { isDigestPinned, resolveVerifierImage } from "../src/sandbox";

/**
 * The verifier image pin.
 *
 * The failure mode this file guards is a reproducibility claim resting on a
 * moving tag: `:latest` is whatever was built last, so two re-runs a week
 * apart can execute in different environments while both receipts say
 * "verified". The override must therefore be able to carry a digest, and
 * the checker must not call a tag a pin.
 */

describe("resolveVerifierImage", () => {
  it("defaults to the mutable tag when no override is set", () => {
    expect(resolveVerifierImage({})).toBe("crucible/verifier:latest");
  });

  it("honours a digest override", () => {
    const digest = `crucible/verifier@sha256:${"a".repeat(64)}`;
    expect(resolveVerifierImage({ CRUCIBLE_VERIFIER_IMAGE: digest })).toBe(digest);
  });

  it("ignores a blank override", () => {
    expect(resolveVerifierImage({ CRUCIBLE_VERIFIER_IMAGE: "   " })).toBe("crucible/verifier:latest");
  });
});

describe("isDigestPinned", () => {
  it("accepts a full sha256 digest reference", () => {
    expect(isDigestPinned(`crucible/verifier@sha256:${"a".repeat(64)}`)).toBe(true);
  });

  it("refuses tags, short digests and other algorithms", () => {
    expect(isDigestPinned("crucible/verifier:latest")).toBe(false);
    expect(isDigestPinned("crucible/verifier@sha256:abc")).toBe(false);
    expect(isDigestPinned(`crucible/verifier@sha512:${"a".repeat(128)}`)).toBe(false);
  });
});
