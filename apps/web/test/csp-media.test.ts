import { describe, expect, it, vi } from "vitest";

/**
 * The CSP gate for media.
 *
 * `default-src 'self'` does not extend to `blob:` for `<audio>`/`<video>`, so a page whose
 * media comes from a fetched Blob fails with "no supported source was found" — the same
 * message a dead provider or an unsupported codec produces. Frenchy was silent in production
 * for exactly this reason while working in development, because the CSP is only emitted in a
 * production build.
 *
 * This asserts on the real config object rather than a copy of the string, so editing the
 * header list in next.config.mjs is what fails or passes the test.
 */
async function productionHeaders(): Promise<{ key: string; value: string }[]> {
  vi.resetModules();
  const env = process.env as Record<string, string | undefined>;
  const previous = env.NODE_ENV;
  env.NODE_ENV = "production";
  try {
    const config = (await import("../next.config.mjs")).default;
    const entries = (await config.headers()) as { source: string; headers: { key: string; value: string }[] }[];
    return entries[0]?.headers ?? [];
  } finally {
    env.NODE_ENV = previous;
  }
}

function directive(csp: string, name: string): string | undefined {
  return csp.split("; ").find((d) => d.startsWith(`${name} `));
}

describe("the production CSP and fetched media", () => {
  it("ships a Content-Security-Policy in a production build", async () => {
    const headers = await productionHeaders();
    expect(headers.find((h) => h.key === "Content-Security-Policy")).toBeDefined();
  });

  it("names media-src explicitly, because default-src 'self' refuses blob: audio", async () => {
    const headers = await productionHeaders();
    const csp = headers.find((h) => h.key === "Content-Security-Policy")?.value ?? "";
    const media = directive(csp, "media-src");
    expect(media, `media-src is absent; the browser falls back to default-src and blocks the clip`).toBeDefined();
    expect(media).toContain("blob:");
  });

  it("keeps every source type that escapes default-src spelled out", async () => {
    const headers = await productionHeaders();
    const csp = headers.find((h) => h.key === "Content-Security-Policy")?.value ?? "";
    // Each of these has a runtime need that 'self' cannot satisfy; dropping one is a silent
    // feature loss, not a tightening.
    for (const name of ["img-src", "worker-src", "media-src", "connect-src", "frame-src"]) {
      expect(directive(csp, name), `${name} missing`).toBeDefined();
    }
    expect(directive(csp, "object-src")).toBe("object-src 'none'");
  });
});
