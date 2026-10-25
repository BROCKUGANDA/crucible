/**
 * Per-run egress allowlist.
 *
 * The container already runs with `--network=none`, so a trial's agent cannot reach the internet
 * from inside the sandbox. The one path it *can* leave by is the model call, which the host
 * process makes on the agent's behalf — and that is the path a misconfigured provider, a
 * redirected `baseUrl`, or a prompt-injected tool call would take.
 *
 * This is the idea `@crucible/harness` named in a field it never populated
 * (`egressAllowlist: [], // populated by adapter proxy`); that package was a process-boundary
 * simulation of a sandbox production already implements for real, so it was deleted rather than
 * wired in. The capability belongs to the real path, and here it is.
 *
 * **The rule:** a host is reachable only if it is listed, or is a subdomain of a listed domain
 * written with a leading dot. `api.nvidia.com` does not authorise `api.nvidia.com.evil.test`,
 * and `.nvidia.com` does not authorise `evilanthropic.com`.
 */

/** Thrown when a run tries to reach a host it was not granted. */
export class EgressDenied extends Error {
  constructor(host: string, allowlist: readonly string[]) {
    super(
      `egress to ${host} is not allowed by this run's allowlist ` +
        `(${[...allowlist].join(", ") || "empty"}) — refusing to fetch`,
    );
    this.name = "EgressDenied";
  }
}

function hostOf(url: string): string {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`egress target is not a URL: ${url}`);
  }
  return parsed.hostname.toLowerCase();
}

/**
 * Whether `host` is covered by `allowlist`.
 *
 * An entry is either an exact host (`api.nvidia.com`) or a domain suffix written with a leading
 * dot (`.nvidia.com`, which covers `integrate.api.nvidia.com`). A bare `nvidia.com` is treated as
 * an exact host, not a suffix — otherwise a typo in one character of an allowlist would open a
 * whole domain.
 */
export function hostAllowed(host: string, allowlist: readonly string[]): boolean {
  const h = host.toLowerCase();
  for (const raw of allowlist) {
    const entry = raw.trim().toLowerCase();
    if (entry.length === 0) continue;
    if (entry.startsWith(".")) {
      if (h.endsWith(entry)) return true;
      continue;
    }
    if (h === entry) return true;
  }
  return false;
}

/**
 * Refuse a target that this run was not granted.
 *
 * An **empty or absent** allowlist means "no egress check": the caller has not configured one, and
 * the existing provider guard (scheme and URL validity) still applies. A caller that wants a hard
 * deny passes an empty array and gets every request refused.
 */
export function assertEgressAllowed(url: string, allowlist?: readonly string[]): void {
  if (!allowlist) return;
  const host = hostOf(url);
  if (!hostAllowed(host, allowlist)) throw new EgressDenied(host, allowlist);
}
