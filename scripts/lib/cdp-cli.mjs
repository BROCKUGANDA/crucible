/**
 * Shared plumbing for the `cdp` CLI wrappers: environment selection, key
 * resolution, and one call site that can show HTTP headers without printing the
 * credential that signs them.
 *
 * Two CLI facts drive the shape of this module:
 *   - a request header is passed as a bare `Name:value` field token, and the CLI
 *     only reads a token as a header when its first character is A-Z, so
 *     `idempotency-key:x` is silently treated as a body field;
 *   - `-v` writes the header block to stderr while `-i` writes it to stdout,
 *     ahead of the JSON body. We use `-v` so stdout stays parseable.
 */
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

export const SANDBOX_BASE_URL = "https://sandbox.cdp.coinbase.com";
export const LIVE_BASE_URL = "https://api.cdp.coinbase.com/platform/v2";

const CREDENTIAL_HEADER = /^(authorization|x-wallet-auth|.*api-key.*|.*secret.*|.*token.*)$/i;

export function cdpConfig(env = process.env) {
  const envName = env.CDP_ENV?.trim() || "sandbox";
  const live = envName === "live";
  const rawKeyFile = live
    ? env.CDP_LIVE_API_KEY_FILE?.trim() || env.CDP_API_KEY_FILE?.trim() || ""
    : env.CDP_SANDBOX_API_KEY_FILE?.trim() || env.CDP_API_KEY_FILE?.trim() || "";
  const keyId = (live ? env.CDP_LIVE_API_KEY_ID : env.CDP_SANDBOX_API_KEY_ID)?.trim() || "";
  const keySecret =
    (live ? env.CDP_LIVE_API_KEY_SECRET : env.CDP_SANDBOX_API_KEY_SECRET)?.trim() || "";
  return {
    envName,
    live,
    allowLive: env.CDP_ENABLE_LIVE === "1",
    plaintext: env.CDP_ALLOW_PLAINTEXT_SECRETS === "1",
    baseUrl:
      (live ? env.CDP_LIVE_BASE_URL : env.CDP_SANDBOX_BASE_URL)?.trim() ||
      (live ? LIVE_BASE_URL : SANDBOX_BASE_URL),
    keyFile: rawKeyFile
      ? rawKeyFile.startsWith("~")
        ? resolve(homedir(), rawKeyFile.slice(1))
        : resolve(process.cwd(), rawKeyFile)
      : "",
    keyId,
    keySecret,
    accountId: env.CDP_ACCOUNT_ID?.trim() || "",
  };
}

export function credentialProblem(cfg) {
  if (cfg.live && !cfg.allowLive) {
    return (
      "CDP live is disabled for this demo. Set CDP_ENV=sandbox, or set " +
      "CDP_ENABLE_LIVE=1 only for an explicitly approved live task with a dedicated live key."
    );
  }
  if (cfg.keyFile) {
    if (!existsSync(cfg.keyFile)) {
      return `No CDP ${cfg.live ? "live" : "sandbox"} key file at ${cfg.keyFile}. Fix the path in .env.`;
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
    `${cfg.live ? "CDP_LIVE" : "CDP_SANDBOX"}_API_KEY_FILE is empty, and the ` +
    `${cfg.live ? "CDP_LIVE" : "CDP_SANDBOX"}_API_KEY_ID/_SECRET pair is incomplete.\n\n` +
    "1. Open the CDP Portal in Sandbox mode (not Live).\n" +
    "2. Settings -> Create Secret API Key -> enable the Accounts permission.\n" +
    "3. Either store the JSON outside this repository and set CDP_SANDBOX_API_KEY_FILE, or set\n" +
    "   CDP_SANDBOX_API_KEY_ID and CDP_SANDBOX_API_KEY_SECRET from the downloaded file.\n" +
    "4. Run `npm run cdp:sandbox` again.\n\n" +
    "A live-mode key will answer 401 against the Sandbox; the modes are separate.\n" +
    "Never commit the key or paste it into chat."
  );
}

/**
 * npm's global bin is often absent from a coding agent's PATH. On Windows the
 * cdp.cmd shim sits next to the node.exe running this script; use that before
 * falling back to PATH.
 */
export function findCdpBin(env = process.env) {
  const candidates = [
    env.CDP_BIN?.trim(),
    process.platform === "win32" ? join(dirname(process.execPath), "cdp.cmd") : null,
    process.platform === "win32" && env.npm_config_prefix
      ? join(env.npm_config_prefix, "cdp.cmd")
      : null,
    process.platform === "win32" ? join(homedir(), "scoop", "persist", "nodejs", "bin", "cdp.cmd") : null,
    process.platform === "win32" ? join(env.APPDATA ?? "", "npm", "cdp.cmd") : null,
  ].filter(Boolean);
  return candidates.find((candidate) => existsSync(candidate)) ?? "cdp";
}

function spawn(bin, args, opts = {}) {
  if (process.platform === "win32") {
    const quote = (value) => `"${String(value).replace(/"/g, '""')}"`;
    return spawnSync([bin, ...args].map(quote).join(" "), {
      shell: true,
      stdio: opts.capture ? ["ignore", "pipe", "pipe"] : "inherit",
      encoding: opts.capture ? "utf8" : undefined,
    });
  }
  return spawnSync(bin, args, {
    stdio: opts.capture ? ["ignore", "pipe", "pipe"] : "inherit",
    encoding: opts.capture ? "utf8" : undefined,
  });
}

export function configure(cfg, bin = findCdpBin()) {
  const args = ["env", cfg.envName];
  if (cfg.keyFile) args.push("--key-file", cfg.keyFile);
  else args.push("--key-id", cfg.keyId, "--key-secret", cfg.keySecret);
  args.push("--url", cfg.baseUrl);
  if (cfg.plaintext) args.push("--plaintext");
  return spawn(bin, args, { capture: true });
}

/** Splits the curl-style `-v` block on stderr into request/response header lines. */
export function parseHeaderBlock(stderr) {
  const request = [];
  const response = [];
  let httpStatus = null;
  for (const raw of (stderr ?? "").split(/\r?\n/)) {
    const line = raw.trimEnd();
    if (line.startsWith("> ")) {
      const value = line.slice(2).trim();
      if (value) request.push(value);
    } else if (line.startsWith("< ")) {
      const value = line.slice(2).trim();
      if (!value) continue;
      if (value.startsWith("HTTP ")) httpStatus = Number(value.slice(5).trim());
      else response.push(value);
    }
  }
  return { request, response, httpStatus };
}

export function redactHeader(line) {
  const split = line.indexOf(":");
  if (split < 0) return line;
  const name = line.slice(0, split).trim();
  if (!CREDENTIAL_HEADER.test(name)) return line;
  return `${name}: <present, not printed>`;
}

/**
 * One authenticated call. Returns the parsed body plus the header block that
 * `-v` echoed, with credential-bearing values redacted so the same output is
 * safe to paste into a runbook or a demo.
 */
export function api(cfg, bin, args, { quiet = false } = {}) {
  const result = spawn(bin, ["api", ...args, "-e", cfg.envName, "-v"], { capture: true });
  const stdout = result.stdout ?? "";
  const stderr = result.stderr ?? "";
  const headers = parseHeaderBlock(stderr);
  if (!quiet) {
    if (headers.request.length) {
      console.log(`  request  ${headers.request[0]}`);
      for (const line of headers.request.slice(1)) console.log(`    > ${redactHeader(line)}`);
    }
    if (headers.httpStatus !== null) console.log(`  response HTTP ${headers.httpStatus}`);
    for (const line of headers.response) console.log(`    < ${redactHeader(line)}`);
  }
  let json = null;
  try {
    json = JSON.parse(stdout);
  } catch {
    if (result.status !== 0) throw new Error((stderr.trim().split(/\r?\n/).pop() || `exit ${result.status}`));
    if (stdout.trim()) throw new Error(`response was not JSON: ${stdout.trim().slice(0, 200)}`);
  }
  return { json, headers, status: result.status, stdout, stderr };
}

/** Header field tokens for the CLI: the first character must be uppercase. */
export function header(name, value) {
  const token = `${name}:${value}`;
  if (!/^[A-Z]/.test(name)) throw new Error(`header name must start A-Z or the CLI reads it as a body field: ${token}`);
  if (/["\s]/.test(value)) throw new Error(`header value must not contain spaces or quotes: ${token}`);
  return token;
}
