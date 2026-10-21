#!/usr/bin/env node
/**
 * Configure the CDP Sandbox profile and list its accounts.
 *
 * The Sandbox is a simulated custodial environment: it has no blockchain or
 * testnet connectivity, and its balances are test data. This script does not
 * create an account or spend anything — it imports the Sandbox API key into the
 * `cdp` CLI, switches to the sandbox environment, and runs a read-only account
 * list. Account creation/funding happens in the CDP Portal.
 *
 * The key JSON is never printed. If the path is empty or the file is missing,
 * the script stops before invoking the CLI.
 */
import { existsSync, readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

const envName = process.env.CDP_ENV?.trim() || "sandbox";
const allowLive = process.env.CDP_ENABLE_LIVE === "1";
const plaintext = process.env.CDP_ALLOW_PLAINTEXT_SECRETS === "1";
const live = envName === "live";
const envKeyFile = live
  ? process.env.CDP_LIVE_API_KEY_FILE?.trim() || process.env.CDP_API_KEY_FILE?.trim() || ""
  : process.env.CDP_SANDBOX_API_KEY_FILE?.trim() || process.env.CDP_API_KEY_FILE?.trim() || "";
const envKeyId = live
  ? process.env.CDP_LIVE_API_KEY_ID?.trim() || ""
  : process.env.CDP_SANDBOX_API_KEY_ID?.trim() || "";
const envKeySecret = live
  ? process.env.CDP_LIVE_API_KEY_SECRET?.trim() || ""
  : process.env.CDP_SANDBOX_API_KEY_SECRET?.trim() || "";

if (live && !allowLive) {
  stop(
    "CDP live is disabled for this demo. Set CDP_ENV=sandbox, or set " +
      "CDP_ENABLE_LIVE=1 only for an explicitly approved live task with a " +
      "dedicated live key.",
  );
}

function stop(message) {
  console.error(message);
  process.exit(2);
}

if (!envKeyFile && !(envKeyId && envKeySecret)) {
  stop(
    [
      `${live ? "CDP_LIVE_API_KEY_FILE" : "CDP_SANDBOX_API_KEY_FILE"} is empty, and the ` +
        `${live ? "CDP_LIVE" : "CDP_SANDBOX"}_API_KEY_ID/_SECRET pair is incomplete.`,
      "",
      "1. Open the CDP Portal in Sandbox mode (not Live).",
      "2. Settings -> Create Secret API Key -> enable the Accounts permission.",
      "3. Either store the JSON outside this repository and set " +
        "CDP_SANDBOX_API_KEY_FILE, or set CDP_SANDBOX_API_KEY_ID and " +
        "CDP_SANDBOX_API_KEY_SECRET from the downloaded file.",
      "4. Run `npm run cdp:sandbox` again.",
      "",
      "A live-mode key will answer 401 against the Sandbox; the modes are separate.",
      "Never commit the key or paste it into chat.",
    ].join("\n"),
  );
}

let keyFile = null;
if (envKeyFile) {
  const rawKey = envKeyFile;
  keyFile = rawKey.startsWith("~")
    ? resolve(homedir(), rawKey.slice(1))
    : resolve(process.cwd(), rawKey);

  if (!existsSync(keyFile)) {
    stop(`No CDP ${live ? "live" : "sandbox"} key file at ${keyFile}. Fix the path in .env.`);
  }

  try {
    const parsed = JSON.parse(readFileSync(keyFile, "utf8"));
    if (!parsed || typeof parsed !== "object") throw new Error("not a JSON object");
  } catch {
    stop(`The file at ${keyFile} is not a CDP API key JSON object.`);
  }
}

// npm's global bin is often absent from a coding agent's PATH. On Windows the
// cdp.cmd shim sits next to the node.exe that is running this script; use that
// before falling back to PATH.
const cdpCandidates = [
  process.env.CDP_BIN?.trim(),
  process.platform === "win32" ? join(dirname(process.execPath), "cdp.cmd") : null,
  process.platform === "win32" && process.env.npm_config_prefix
    ? join(process.env.npm_config_prefix, "cdp.cmd")
    : null,
  process.platform === "win32" ? join(homedir(), "scoop", "persist", "nodejs", "bin", "cdp.cmd") : null,
  process.platform === "win32" ? join(process.env.APPDATA ?? "", "npm", "cdp.cmd") : null,
].filter(Boolean);
const cdpBin = cdpCandidates.find((candidate) => existsSync(candidate)) ?? "cdp";

function run(args) {
  if (process.platform === "win32") {
    const quote = (value) => `"${String(value).replace(/"/g, '""')}"`;
    return spawnSync([cdpBin, ...args].map(quote).join(" "), {
      shell: true,
      stdio: "inherit",
    });
  }
  return spawnSync(cdpBin, args, { stdio: "inherit" });
}

console.log(`Configuring CDP environment "${envName}"...`);
const envArgs = ["env", envName];
if (keyFile) {
  envArgs.push("--key-file", keyFile);
} else {
  envArgs.push("--key-id", envKeyId, "--key-secret", envKeySecret);
}
if (envName === "sandbox") {
  envArgs.push("--url", process.env.CDP_SANDBOX_BASE_URL?.trim() || "https://sandbox.cdp.coinbase.com");
}
if (plaintext) envArgs.push("--plaintext");
const configured = run(envArgs);
if (configured.error || configured.status !== 0) {
  console.error(
    "Could not configure the CDP environment. Is `@coinbase/cdp-cli` installed? " +
      "Run `npm i -g @coinbase/cdp-cli` and try again.",
  );
  process.exit(configured.status ?? 1);
}

console.log(`Listing ${envName} accounts...`);
// The long form from the CDP quickstart; the short `accounts balance` form is
// not present in every CLI version, and `/platform/v2` must be explicit.
const listed = run(["api", "/platform/v2/accounts"]);
if (listed.error || listed.status !== 0) {
  process.exit(listed.status ?? 1);
}

console.log(
  "\nIf the list is empty, create and fund a Sandbox account in the CDP Portal " +
    "(Sandbox -> Accounts). Its balances are simulated USD/USDC/USDT; no real funds " +
    "or testnet assets can be sent to it.",
);
