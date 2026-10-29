import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/**
 * The Permissions-Policy gate for the microphone.
 *
 * **What this is for.** The policy said `microphone=()` while the product had
 * shipped a voice control since 2026-10-28. The browser refuses the
 * microphone under `microphone=()` *before the visitor is ever prompted*, so the
 * button could not work, and the refusal told the visitor to change their
 * browser settings — which was not what was wrong. Nobody noticed, because the
 * failure looks like a browser refusing a permission rather than a header
 * forbidding a feature the product ships.
 *
 * So the policy is asserted here, on the real config object rather than on a
 * copy of the string: editing the header list in `next.config.mjs` is what
 * fails or passes this test.
 *
 * **What it does not assert.** That the microphone is *used* — only a click can
 * open it, and that is a behaviour rather than a header. What it does assert is
 * that the header says what the product needs: this origin may ask, no other
 * origin may, and the features the product has no use for stay closed.
 */

async function headers(): Promise<{ key: string; value: string }[]> {
  vi.resetModules();
  const config = (await import("../next.config.mjs")).default;
  const entries = (await config.headers()) as {
    source: string;
    headers: { key: string; value: string }[];
  }[];
  // The `/:path*` rule is the one that carries the global policy.
  const global = entries.find((e) => e.source === "/:path*");
  return global?.headers ?? [];
}

function policy(entries: { key: string; value: string }[]): string {
  return entries.find((h) => h.key === "Permissions-Policy")?.value ?? "";
}

describe("the microphone policy", () => {
  it("opens the microphone to this origin, because the product ships a voice control", async () => {
    const value = policy(await headers());
    expect(value).toContain("microphone=(self)");
    expect(
      value,
      "microphone=() makes the browser refuse the microphone before the visitor is prompted, so the shipped Listen button cannot work",
    ).not.toContain("microphone=()");
  });

  it("keeps every feature the product has no use for closed", async () => {
    const value = policy(await headers());
    for (const closed of ["camera=()", "geolocation=()", "payment=()", "usb=()", "display-capture=()"]) {
      expect(value, `${closed} is not closed`).toContain(closed);
    }
  });

  it("does not open the microphone to anybody else", async () => {
    const value = policy(await headers());
    // `(self)` and nothing else: another origin may not ask, and a wildcard
    // would let a page the visitor has never seen hold the microphone.
    const microphone = value.split(", ").find((d) => d.startsWith("microphone="));
    expect(microphone).toBe("microphone=(self)");
  });

  it("asks for the microphone only on a press", () => {
    // The policy lets the page *ask*; it does not ask. The only place the
    // microphone is opened is inside a recorder's `start()`, and the only
    // callers of that are click handlers.
    const lib = readFileSync(
      fileURLToPath(new URL("../src/lib/sts.ts", import.meta.url)),
      "utf8",
    );
    expect(lib).toContain("getUserMedia");

    const provider = readFileSync(
      fileURLToPath(new URL("../src/lib/frenchy/provider.tsx", import.meta.url)),
      "utf8",
    );
    // The provider's `enable()` is the click handler's target; a page-load call
    // would show up as a call outside it.
    const enable = provider.slice(provider.indexOf("async function enable()"));
    const body = enable.slice(0, enable.indexOf("\n  }\n"));
    expect(body).toContain("getUserMedia");
  });
});
