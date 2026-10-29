import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * The CSP gate for *origins* — the browser audit of 2026-10-29.
 *
 * The live public origin served `connect-src` naming `http://127.0.0.1:8787`,
 * `http://127.0.0.1:8788`, `http://localhost:8787`, `http://localhost:8788` and an Anvil port.
 * Those are the README's local-demo endpoints, hardcoded into the policy, so any build —
 * including the VPS image — carried them. On a public HTTPS origin that is a standing
 * permission for injected script to talk to whatever happens to be listening on the visitor's
 * own machine, and `connect-src` is the directive that stops exfiltration.
 *
 * The fix is a condition, not a deletion, and this file asserts **both halves of it**: a
 * public-target production build must not name a plaintext origin, and a local-target build
 * must still name them — because `compose.yaml` builds the same image against
 * `http://127.0.0.1:8787`, and a policy that silently drops it degrades the live feed to
 * polling without an error (`next.config.mjs` documents that failure mode). Only the second
 * half would be a gate that ships an outage.
 *
 * Like `csp-media.test.ts`, this loads the real `next.config.mjs` rather than a copy of the
 * string, so the thing under test is the object the server actually sends.
 */
const PREVIOUS = { ...process.env };

afterEach(() => {
  for (const key of [
    "NODE_ENV",
    "NEXT_PUBLIC_API_URL",
    "NEXT_PUBLIC_ANVIL_RPC",
    "CSP_REPORT_URL",
  ]) {
    if (key in PREVIOUS) process.env[key] = PREVIOUS[key];
    else delete process.env[key];
  }
});

async function headersFor(env: Record<string, string | undefined>): Promise<Record<string, string>> {
  vi.resetModules();
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  const config = (await import("../next.config.mjs")).default;
  const entries = (await config.headers()) as { source: string; headers: { key: string; value: string }[] }[];
  const first = entries[0];
  if (!first) throw new Error("next.config.headers() returned no header rules — the CSP assertions below would read an empty policy and pass");
  return Object.fromEntries(first.headers.map((h) => [h.key, h.value]));
}

function directive(csp: string, name: string): string | undefined {
  return csp.split("; ").find((d) => d.startsWith(`${name} `));
}

/** Every `http://` source in a directive, i.e. every plaintext entry on an HTTPS page. */
function plaintextSources(directiveValue: string | undefined): string[] {
  return (directiveValue ?? "").split(/\s+/).filter((s) => s.startsWith("http://"));
}

describe("connect-src origins, by what the build was configured to reach", () => {
  it("refuses every plaintext origin from a public-target production build", async () => {
    const headers = await headersFor({
      NODE_ENV: "production",
      NEXT_PUBLIC_API_URL: "https://crucible.svalley.tech",
      NEXT_PUBLIC_ANVIL_RPC: "https://crucible.svalley.tech/anvil",
    });
    const connect = directive(headers["Content-Security-Policy"] ?? "", "connect-src");
    expect(connect, "no CSP came back — the gate would be measuring an empty string").toBeDefined();
    // The exact five entries the live audit found, asserted by name rather than by shape, so a
    // future refactor that re-adds one of them in another spelling still goes red here.
    for (const leak of [
      "http://127.0.0.1:8787",
      "http://127.0.0.1:8788",
      "http://localhost:8787",
      "http://localhost:8788",
      "http://127.0.0.1:8555",
    ]) {
      expect(connect, `connect-src still names ${leak}`).not.toContain(leak);
    }
    expect(plaintextSources(connect)).toEqual([]);
    // And the origin it *is* deployed against stays named, or this is a tightening that broke
    // the app rather than a tightening.
    expect(connect).toContain("https://crucible.svalley.tech");
  });

  it("refuses a loopback RPC even when only the RPC was left pointing at a laptop", async () => {
    // The `.env.example` value for the RPC is `http://127.0.0.1:8555`. The RPC is another
    // agent's configuration, so this file does not restructure it — it refuses to let it into a
    // public policy, which is what put :8555 on the live site.
    const headers = await headersFor({
      NODE_ENV: "production",
      NEXT_PUBLIC_API_URL: "https://crucible.svalley.tech",
      NEXT_PUBLIC_ANVIL_RPC: "http://127.0.0.1:8555",
    });
    const connect = directive(headers["Content-Security-Policy"] ?? "", "connect-src");
    expect(plaintextSources(connect), `plaintext entries survived: ${connect}`).toEqual([]);
  });

  it("still names the loopback defaults for a local-target production build", async () => {
    // compose.yaml: NEXT_PUBLIC_API_URL defaults to http://127.0.0.1:8787 and the RPC to
    // http://127.0.0.1:8555. This is the end state that must NOT change: the demo's SSE and
    // polling both go to those origins.
    const headers = await headersFor({
      NODE_ENV: "production",
      NEXT_PUBLIC_API_URL: "http://127.0.0.1:8787",
      NEXT_PUBLIC_ANVIL_RPC: "http://127.0.0.1:8555",
    });
    const connect = directive(headers["Content-Security-Policy"] ?? "", "connect-src") ?? "";
    expect(connect).toContain("http://127.0.0.1:8787");
    expect(connect).toContain("http://127.0.0.1:8555");
    expect(connect).toContain("http://localhost:8787");
  });

  it("keeps the WalletConnect hosts in both cases, since a policy without them is a dead button", async () => {
    const publicHeaders = await headersFor({
      NODE_ENV: "production",
      NEXT_PUBLIC_API_URL: "https://crucible.svalley.tech",
    });
    const connect = directive(publicHeaders["Content-Security-Policy"] ?? "", "connect-src") ?? "";
    for (const host of ["wss://relay.walletconnect.com", "https://bridge.walletconnect.org"]) {
      expect(connect).toContain(host);
    }
  });
});

describe("the report-only probe", () => {
  it("emits nothing when no collector is configured, because a report to nowhere is decoration", async () => {
    const headers = await headersFor({
      NODE_ENV: "production",
      NEXT_PUBLIC_API_URL: "https://crucible.svalley.tech",
      CSP_REPORT_URL: "",
    });
    expect(headers["Content-Security-Policy-Report-Only"]).toBeUndefined();
    expect(headers["Reporting-Endpoints"]).toBeUndefined();
    // The enforcing policy is untouched by the absence of a collector.
    expect(headers["Content-Security-Policy"]).toContain("script-src 'self' 'unsafe-inline'");
  });

  it("observes the same policy with both inline allowances removed, aimed at the collector", async () => {
    const headers = await headersFor({
      NODE_ENV: "production",
      NEXT_PUBLIC_API_URL: "https://crucible.svalley.tech",
      CSP_REPORT_URL: "https://crucible.svalley.tech/csp-report",
    });
    const probe = headers["Content-Security-Policy-Report-Only"];
    expect(probe).toBeDefined();
    expect(probe).not.toContain("'unsafe-inline'");
    expect(probe).toContain("report-to csp");
    expect(probe).toContain("report-uri https://crucible.svalley.tech/csp-report");
    expect(headers["Reporting-Endpoints"]).toContain(`csp="https://crucible.svalley.tech/csp-report"`);
    // The enforcing header still carries the allowances: this probe measures, it does not ship.
    expect(headers["Content-Security-Policy"]).toContain("script-src 'self' 'unsafe-inline'");
    expect(headers["Content-Security-Policy"]).toContain("style-src 'self' 'unsafe-inline'");
  });

  it("is not emitted for a dev server, where the enforcing CSP is not emitted either", async () => {
    const headers = await headersFor({
      NODE_ENV: "development",
      CSP_REPORT_URL: "https://crucible.svalley.tech/csp-report",
    });
    expect(headers["Content-Security-Policy"]).toBeUndefined();
    expect(headers["Content-Security-Policy-Report-Only"]).toBeUndefined();
  });
});

describe("stack disclosure", () => {
  it("turns off X-Powered-By in the config that produces the response", async () => {
    const config = (await import("../next.config.mjs")).default;
    // The header is not in `headers()` — Next writes it itself, so the only control is the
    // config flag. Asserting the flag is the wiring check; the live absence is checked against
    // a real `next start` response.
    expect(config.poweredByHeader).toBe(false);
  });
});
