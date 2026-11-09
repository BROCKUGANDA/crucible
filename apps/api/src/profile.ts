/**
 * The deployment profile, and what each one may be on this build.
 *
 * The infrastructure runbook prescribes three isolated profiles — public demo, Sepolia
 * preview, production — selected by configuration, never by a browser flag. This build
 * ships the demo: its chain fence, its valueless escrow and its public RPC gate are the
 * demo's. Preview and production are refused, loudly, until their gates exist (signed
 * deployment manifest, verified Safes, audited contracts, durable state), because a
 * profile switch that "works" is a profile switch that can point a demo at mainnet.
 *
 * The chain id is proven against the RPC elsewhere (`verifyChainAtBoot`); this module
 * refuses the *configuration*, not the network answer. It lives in its own file so the
 * refusals are unit-testable without booting a server.
 */

export type CrucibleProfile = "demo" | "preview" | "production";

const PROFILES: readonly CrucibleProfile[] = ["demo", "preview", "production"];

/**
 * Resolve `CRUCIBLE_PROFILE`.
 *
 * Unset means the previous behaviour — no profile, no gate — not "demo". The gate exists
 * to stop a profile that contradicts its chain, not to punish a host that never set it:
 * a static default would crash-loop every container whose `.env` predates the variable
 * (measured 2026-11-09: the VPS `.env` had no such line, and the swapped API container
 * went unhealthy on its first health probe). `demo` is what the compose default builds
 * and what the local stack declares; a host declares one only by setting it.
 */
export function resolveProfile(raw: string | undefined): CrucibleProfile | null {
  if (raw === undefined || raw.trim() === "") return null;
  const value = raw.trim().toLowerCase();
  if (value === "demo" || value === "preview" || value === "production") return value;
  throw new Error(
    `unknown CRUCIBLE_PROFILE "${value}"; expected one of ${PROFILES.join(", ")}`,
  );
}

export interface ProfileEnv {
  chainId: number;
  env: NodeJS.ProcessEnv;
}

/**
 * Refuse a profile whose invariants this host does not meet.
 *
 * Demo is allowed only on the local Anvil chain (31337) and only with
 * `REAL_VALUE_OPERATIONS=0`: the demo escrow holds test ETH worth nothing, and a
 * "real-value" flag on it is a contradiction, not a setting. Preview and production
 * refuse to boot at all in this build — the gates in the runbook are the price of
 * admission, and refusing is safer than looking like a production profile.
 */
export function validateProfile(profile: CrucibleProfile, { chainId, env }: ProfileEnv): void {
  if (profile === "demo") {
    if (chainId !== 31337) {
      throw new Error(
        `CRUCIBLE_PROFILE=demo requires CHAIN_ID=31337 (the local Anvil chain); got ${chainId}. ` +
          "A demo profile on any other chain is a deployment mistake, not a configuration.",
      );
    }
    const realValue = (env.REAL_VALUE_OPERATIONS ?? "0").trim();
    if (realValue !== "0") {
      throw new Error(
        `CRUCIBLE_PROFILE=demo requires REAL_VALUE_OPERATIONS=0; got "${realValue}". ` +
          "The demo chain is valueless — a real-value operation on it is a contradiction.",
      );
    }
    return;
  }
  throw new Error(
    `CRUCIBLE_PROFILE=${profile} is not implemented in this build: it requires the ` +
      "preview/production gates (signed deployment manifest, verified Safes, audited " +
      "contracts, durable state) described in docs/runbooks/profiles.md. Refusing to " +
      "start rather than run a profile that only looks like one.",
  );
}
