import { describe, expect, it } from "vitest";
import { assertEgressAllowed, EgressDenied, hostAllowed } from "../src/egress.js";
import { anthropicClient, nimClient, openAiCompatibleClient } from "../src/index.js";

describe("the egress allowlist", () => {
  it("lets a listed host through", () => {
    expect(() =>
      assertEgressAllowed("https://integrate.api.nvidia.com/v1/chat/completions", [
        "integrate.api.nvidia.com",
      ]),
    ).not.toThrow();
  });

  it("refuses a host that was not granted, and names it", () => {
    expect(() =>
      assertEgressAllowed("https://api.openai.com/v1/chat/completions", ["integrate.api.nvidia.com"]),
    ).toThrow(EgressDenied);
    try {
      assertEgressAllowed("https://api.openai.com/v1/chat/completions", ["integrate.api.nvidia.com"]);
      expect.unreachable("the call should have thrown");
    } catch (err) {
      expect((err as Error).message).toContain("api.openai.com");
      expect((err as Error).message).toContain("integrate.api.nvidia.com");
    }
  });

  it("reads a leading dot as a domain suffix, not a prefix", () => {
    expect(hostAllowed("integrate.api.nvidia.com", [".nvidia.com"])).toBe(true);
    // A suffix match must not be satisfied by a name that merely ends in the same letters.
    expect(hostAllowed("eviliconvidia.com", [".nvidia.com"])).toBe(false);
    // And a host that merely *starts* with an allowed name is not covered by it.
    expect(hostAllowed("integrate.api.nvidia.com.evil.test", ["integrate.api.nvidia.com"])).toBe(false);
  });

  it("treats a bare entry as an exact host, so one typo cannot open a domain", () => {
    expect(hostAllowed("api.nvidia.com", ["nvidia.com"])).toBe(false);
    expect(hostAllowed("nvidia.com", ["nvidia.com"])).toBe(true);
  });

  it("checks nothing when no allowlist is configured, and everything when it is empty", () => {
    expect(() => assertEgressAllowed("https://api.openai.com/v1")).not.toThrow();
    expect(() => assertEgressAllowed("https://api.openai.com/v1", [])).toThrow(EgressDenied);
  });

  it("refuses a non-URL target rather than treating it as a host", () => {
    expect(() => assertEgressAllowed("not a url", ["api.openai.com"])).toThrow(/not a URL/);
  });
});

describe("the allowlist on the clients that make the requests", () => {
  it("refuses a provider the run was not granted, before any request is made", () => {
    expect(() =>
      openAiCompatibleClient({
        apiKey: "k",
        baseUrl: "https://api.openai.com/v1",
        egressAllowlist: ["integrate.api.nvidia.com"],
      }),
    ).toThrow(EgressDenied);
  });

  it("allows the provider the run was granted", () => {
    expect(() =>
      nimClient({ apiKey: "k", egressAllowlist: ["integrate.api.nvidia.com"] }),
    ).not.toThrow();
  });

  it("guards the Anthropic client, which had no URL check at all before", () => {
    // A `file://` baseUrl must be refused by the scheme guard, not fetched.
    expect(() => anthropicClient({ apiKey: "k", baseUrl: "file:///etc/hostname" })).toThrow(
      /must be http\(s\)/,
    );
    // And a host outside the allowlist is refused even though the scheme is fine.
    expect(() =>
      anthropicClient({
        apiKey: "k",
        baseUrl: "https://api.openai.com",
        egressAllowlist: ["api.anthropic.com"],
      }),
    ).toThrow(EgressDenied);
  });
});
