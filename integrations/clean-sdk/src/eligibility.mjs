/**
 * One read-only use of @human.tech/clean.sdk: the unauthenticated L1 eligibility check.
 *
 * `HumanTechBridge.checkL1Eligibility(address)` calls
 * `GET /api/attestation/l1-eligibility?address=...` — a POCH -> Passport cascade plus a
 * sanctions screen keyed only on the address. It needs no session, no API key and no wallet
 * signature, and it never touches the bridge, a token, or a chain transaction.
 *
 * The SDK's constructor still demands `l1RpcUrl` and (in Node) `domain`. Those are satisfied
 * by configuration and are not dialled by this route; the tests point them at an unreachable
 * port to prove that.
 */

import { HumanTechBridge } from "@human.tech/clean.sdk";

const ADDRESS = /^0x[0-9a-fA-F]{40}$/;

/**
 * Map the vendor's field names onto the API's contract.
 *
 * `passportScore` / `passportThreshold` are present only when the Passport tier was
 * evaluated (POCH not satisfied). Absent is unknown, never zero. An address echo that does
 * not match the request is refused rather than relabelled: a credential for another wallet
 * is not evidence about this one.
 */
export function normalizeEligibility(raw, address) {
  if (!raw || typeof raw !== "object") {
    throw new Error("passport source returned no usable body");
  }
  if (typeof raw.address === "string" && raw.address.toLowerCase() !== address.toLowerCase()) {
    throw new Error(`passport source answered for ${raw.address}, not ${address}`);
  }
  return {
    address: address.toLowerCase(),
    eligible: raw.eligible === true,
    method: raw.method === "poch" || raw.method === "passport" ? raw.method : null,
    score: typeof raw.passportScore === "number" && Number.isFinite(raw.passportScore) ? raw.passportScore : null,
    threshold:
      typeof raw.passportThreshold === "number" && Number.isFinite(raw.passportThreshold)
        ? raw.passportThreshold
        : null,
    maxAmount: typeof raw.passportMaxAmount === "string" ? raw.passportMaxAmount : null,
    sanctioned: raw.sanctioned === true,
    reason: typeof raw.reason === "string" ? raw.reason : null,
  };
}

/**
 * A cached, read-only eligibility source.
 *
 * A cold vendor call can take seconds. The API gives this hop one second and reports the
 * source unavailable when it expires — but the sidecar keeps the vendor call alive and caches
 * the answer, so the next request is answered locally. The cache is per-process, address-keyed,
 * and five minutes by default; concurrent checks for one address share a single in-flight call
 * rather than multiplying the vendor's load.
 */
export function createEligibilitySource({
  apiUrl,
  l1RpcUrl,
  domain,
  timeoutMs = 20_000,
  ttlMs = 5 * 60_000,
  now = Date.now,
}) {
  if (!l1RpcUrl) throw new Error("l1RpcUrl is required by the SDK constructor");
  if (!domain) throw new Error("domain is required by the SDK in Node.js");
  const bridge = new HumanTechBridge({ apiUrl, l1RpcUrl, domain });

  const cache = new Map();
  const inflight = new Map();

  async function read(address) {
    // The SDK method takes no signal, so bound the *response* here rather than letting a
    // silent vendor hold this process's connection open. The upstream request may finish
    // later; this sidecar's promise rejects, but the vendor call still populates the cache
    // through the same wrapper.
    let timer;
    const deadline = new Promise((_, reject) => {
      timer = setTimeout(
        () => reject(new Error(`passport source timed out after ${timeoutMs}ms`)),
        timeoutMs,
      );
    });
    try {
      const raw = await Promise.race([bridge.checkL1Eligibility(address), deadline]);
      return normalizeEligibility(raw, address);
    } finally {
      clearTimeout(timer);
    }
  }

  return {
    async check(address) {
      if (!ADDRESS.test(address)) {
        throw new Error("wallet must be a 0x-prefixed 20-byte Ethereum address");
      }
      const key = address.toLowerCase();

      const hit = cache.get(key);
      if (hit && hit.expires > now()) return hit.value;

      const pending = inflight.get(key);
      if (pending) return pending;

      const call = read(key).then(
        (value) => {
          cache.set(key, { expires: now() + ttlMs, value });
          inflight.delete(key);
          return value;
        },
        (err) => {
          inflight.delete(key);
          throw err;
        },
      );
      inflight.set(key, call);
      return call;
    },
  };
}
