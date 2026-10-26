/**
 * CDP Payments transfer for the funder service.
 *
 * Transfers USDC on Base Sepolia using the Coinbase CDP CLI. The credentials
 * live only in this process — the API never sees them (ADR-0015).
 *
 * The network is a constant: Base Sepolia. It is not a setting, because
 * "which network does the funder touch" must not be answerable by an
 * environment typo (ADR-0015 §2).
 */

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

/** The network the funder dispenses on — constant, not configurable. */
export const NETWORK = "base-sepolia";

/** Asset the funder dispenses. */
export const ASSET = "usdc";

const CREDENTIAL_HEADER = /^(authorization|x-wallet-auth|.*api-key.*|.*secret.*|.*token.*)$/i;

export interface CdpConfig {
  envName: "sandbox" | "live";
  baseUrl: string;
  keyFile: string;
  keyId: string;
  keySecret: string;
}

export function cdpConfig(env = process.env): CdpConfig {
  const envName = (env.CDP_ENV?.trim() || "sandbox") as "sandbox" | "live";
  const rawKeyFile =
    envName === "live"
      ? env.CDP_LIVE_API_KEY_FILE?.trim() || env.CDP_API_KEY_FILE?.trim() || ""
      : env.CDP_SANDBOX_API_KEY_FILE?.trim() || env.CDP_API_KEY_FILE?.trim() || "";
  const keyId =
    (envName === "live" ? env.CDP_LIVE_API_KEY_ID : env.CDP_SANDBOX_API_KEY_ID)?.trim() || "";
  const keySecret =
    (envName === "live" ? env.CDP_LIVE_API_KEY_SECRET : env.CDP_SANDBOX_API_KEY_SECRET)?.trim() || "";
  return {
    envName,
    baseUrl:
      (envName === "live" ? env.CDP_LIVE_BASE_URL : env.CDP_SANDBOX_BASE_URL)?.trim() ||
      (envName === "live"
        ? "https://api.cdp.coinbase.com/platform/v2"
        : "https://sandbox.cdp.coinbase.com"),
    keyFile: rawKeyFile
      ? rawKeyFile.startsWith("~")
        ? resolve(homedir(), rawKeyFile.slice(1))
        : resolve(process.cwd(), rawKeyFile)
      : "",
    keyId,
    keySecret,
  };
}

export function credentialProblem(cfg: CdpConfig): string | null {
  if (cfg.keyFile) {
    if (!existsSync(cfg.keyFile)) {
      return `No CDP ${cfg.envName} key file at ${cfg.keyFile}. Fix the path in .env.`;
    }
    try {
      const parsed = JSON.parse(readFileSync(cfg.keyFile, "utf8"));
      if (!parsed || typeof parsed !== "object") throw new Error("not a JSON object");
    } catch {
      return `The file at ${cfg.keyFile} is not a CDP API key JSON object.`;
    }
    return null;
  }
  if (cfg.keyId && cfg.keySecret) return null;
  return (
    `${cfg.envName.toUpperCase()}_API_KEY_FILE is empty, and the ` +
    `${cfg.envName.toUpperCase()}_API_KEY_ID/_SECRET pair is incomplete.\n\n` +
    "1. Open the CDP Portal.\n" +
    "2. Settings -> Create Secret API Key -> enable the Accounts permission.\n" +
    "3. Either store the JSON outside this repository and set CDP_SANDBOX_API_KEY_FILE, or set\n" +
    `   CDP_${cfg.envName.toUpperCase()}_API_KEY_ID and CDP_${cfg.envName.toUpperCase()}_API_KEY_SECRET from the downloaded file.\n` +
    "4. Run the funder again.\n\n" +
    "Never commit the key or paste it into chat."
  );
}

function findCdpBin(env = process.env): string {
  const candidates = [
    env.CDP_BIN?.trim(),
    process.platform === "win32" ? join(dirname(process.execPath), "cdp.cmd") : null,
    process.platform === "win32" && env.npm_config_prefix
      ? join(env.npm_config_prefix, "cdp.cmd")
      : null,
    process.platform === "win32" ? join(homedir(), "scoop", "persist", "nodejs", "bin", "cdp.cmd") : null,
    process.platform === "win32" ? join(env.APPDATA ?? "", "npm", "cdp.cmd") : null,
  ].filter((c): c is string => c !== null && c !== undefined);
  return candidates.find((candidate) => existsSync(candidate)) ?? "cdp";
}

function redactHeader(line: string): string {
  const split = line.indexOf(":");
  if (split < 0) return line;
  const name = line.slice(0, split).trim();
  if (!CREDENTIAL_HEADER.test(name)) return line;
  return `${name}: <present, not printed>`;
}

/**
 * One authenticated CDP API call. Returns the parsed body plus status.
 */
export function cdpApi(
  cfg: CdpConfig,
  args: string[],
  bin = findCdpBin(),
): Promise<{ json: unknown; status: number; stderr: string }> {
  return new Promise((resolve, reject) => {
    const result = spawnSync(bin, ["api", ...args, "-e", cfg.envName, "-v"], {
      shell: process.platform === "win32",
      stdio: ["ignore", "pipe", "pipe"],
      encoding: "utf8",
    });
    const stdout = result.stdout ?? "";
    const stderr = result.stderr ?? "";
    let json: unknown = null;
    try {
      json = JSON.parse(stdout);
    } catch {
      if (result.status !== 0) {
        reject(new Error(stderr.trim().split(/\r?\n/).pop() || `exit ${result.status}`));
        return;
      }
      if (stdout.trim()) {
        reject(new Error(`response was not JSON: ${stdout.trim().slice(0, 200)}`));
        return;
      }
    }
    resolve({ json, status: result.status ?? -1, stderr });
  });
}

/**
 * Transfer USDC to a wallet on Base Sepolia via CDP Payments.
 *
 * Returns the transfer ID and status, or throws on credential/config errors.
 */
export async function transferUsdc(
  cfg: CdpConfig,
  targetAddress: string,
  amountUsdc: string,
): Promise<{ transferId: string | null; status: string | null }> {
  const runId = `crucible-funder-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

  const common = [
    "source.asset=usdc",
    `target.network=${NETWORK}`,
    `target.address=${targetAddress}`,
    "target.asset=usdc",
    `amount=${amountUsdc}`,
    "asset=usdc",
    `X-Crucible-Run:${runId}`,
  ];

  // Step 1: validate — no funds move.
  const validated = await cdpApi(
    cfg,
    ["-X", "POST", "/platform/v2/transfers", ...common, "validateOnly:=true", "execute:=false", `Idempotency-Key:${runId}-validate`],
  );
  if (validated.status !== 0) {
    throw new Error(`CDP validate failed: ${validated.stderr.trim().split(/\r?\n/).pop() ?? "unknown error"}`);
  }

  // Step 2: execute.
  const executed = await cdpApi(
    cfg,
    ["-X", "POST", "/platform/v2/transfers", ...common, "execute:=true", `Idempotency-Key:${runId}-execute`],
  );
  if (executed.status !== 0) {
    throw new Error(`CDP execute failed: ${executed.stderr.trim().split(/\r?\n/).pop() ?? "unknown error"}`);
  }

  const json = executed.json as Record<string, unknown> | null;
  const transferId =
    json?.transferId ?? (json?.transfer as Record<string, unknown> | null)?.id ?? json?.id ?? null;
  const status = json?.status ?? (json?.transfer as Record<string, unknown> | null)?.status ?? null;

  return { transferId: transferId as string | null, status: status as string | null };
}
