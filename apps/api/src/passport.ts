/**
 * Human Passport eligibility, read from the isolated clean.sdk sidecar.
 *
 * The sidecar (`integrations/clean-sdk`) owns `@human.tech/clean.sdk` and exposes one
 * unauthenticated route, `GET /eligibility/:address`, which the SDK fills from Human Tech's
 * `l1-eligibility` check (POCH -> Passport cascade plus a sanctions screen). This module is
 * the API's only contact with it: an HTTP read with a deadline, never a bridge, never a
 * transaction, and never a key.
 *
 * The three states are different and are reported as such:
 *
 *   configured: false  — no source URL on this host. Nothing was asked, so nothing is claimed.
 *   configured: true, available: false — the source was asked and did not answer. A timeout is
 *     not an abstention by the wallet, so it contributes no signal.
 *   configured: true, available: true — a credential exists. `eligible` and `sanctioned` are
 *     facts about that credential; "not eligible" is still not evidence of a sybil.
 */

export interface PassportEligibility {
  configured: boolean;
  available: boolean;
  eligible: boolean | null;
  method: "poch" | "passport" | null;
  score: number | null;
  threshold: number | null;
  sanctioned: boolean | null;
  reason: string | null;
}

export type PassportCheck = (wallet: string) => Promise<PassportEligibility>;

const UNCONFIGURED: PassportEligibility = {
  configured: false,
  available: false,
  eligible: null,
  method: null,
  score: null,
  threshold: null,
  sanctioned: null,
  reason: "No Human Passport service is configured on this host",
};

function unavailable(reason: string): PassportEligibility {
  return { ...UNCONFIGURED, configured: true, reason };
}

function finiteOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/**
 * Build the check for one deployment. `url` empty means the source is unconfigured, and the
 * returned function keeps saying so without a network call.
 */
export function createPassportSource(
  url: string | null,
  opts: { timeoutMs?: number; fetchImpl?: typeof fetch } = {},
): PassportCheck {
  const base = (url ?? "").trim().replace(/\/+$/, "");
  if (!base) return async () => UNCONFIGURED;

  // Short on purpose: this runs inside `/identity/risk`, which the funder reads with a 1.5s
  // deadline. The sidecar is loopback, so a second is already generous.
  const timeoutMs = opts.timeoutMs ?? 1000;
  const fetchImpl = opts.fetchImpl ?? fetch;

  return async (wallet: string): Promise<PassportEligibility> => {
    if (!/^0x[0-9a-fA-F]{40}$/.test(wallet)) {
      return unavailable("wallet must be a 0x-prefixed 20-byte Ethereum address");
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetchImpl(`${base}/eligibility/${encodeURIComponent(wallet)}`, {
        signal: controller.signal,
        headers: { accept: "application/json" },
      });
      if (!res.ok) return unavailable(`passport source answered ${res.status}`);

      const body = (await res.json().catch(() => null)) as Record<string, unknown> | null;
      if (!body || typeof body !== "object") {
        return unavailable("passport source returned no usable body");
      }

      const method = body.method === "poch" || body.method === "passport" ? body.method : null;
      return {
        configured: true,
        available: true,
        eligible: typeof body.eligible === "boolean" ? body.eligible : null,
        method,
        score: finiteOrNull(body.score),
        threshold: finiteOrNull(body.threshold),
        sanctioned: typeof body.sanctioned === "boolean" ? body.sanctioned : null,
        reason: typeof body.reason === "string" ? body.reason : null,
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return unavailable(
        controller.signal.aborted
          ? `passport source timed out after ${timeoutMs}ms`
          : `passport source did not answer: ${message}`,
      );
    } finally {
      clearTimeout(timer);
    }
  };
}
