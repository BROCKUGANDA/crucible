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
import { resolve } from "node:path";

const envName = process.env.CDP_ENV?.trim() || "sandbox";
const allowLive = process.env.CDP_ENABLE_LIVE === "1";
const plaintext = process.env.CDP_ALLOW_PLAINTEXT_SECRETS === "1";
const envKeyFile =
  envName === "live"
    ? process.env.CDP_LIVE_API_KEY_FILE?.trim() || process.env.CDP_API_KEY_FILE?.trim() || ""
    : process.env.CDP_SANDBOX_API_KEY_FILE?.trim() || process.env.CDP_API_KEY_FILE?.trim() || "";
const rawKey = envKeyFile;

if (envName === "live" && !allowLive) {
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

if (!rawKey) {
  stop(
    [
      `${envName === "live" ? "CDP_LIVE_API_KEY_FILE" : "CDP_SANDBOX_API_KEY_FILE"} is empty.`,
      "",
      "1. Open the CDP Portal in Sandbox mode (not Live).",
      "2. Settings -> Create Secret API Key -> enable the Accounts permission.",
      "3. Store the JSON outside this repository (e.g. %USERPROFILE%\\Downloads\\sandbox-api-key.json).",
      "4. Set CDP_SANDBOX_API_KEY_FILE to that path in .env.",
      "5. Run `npm run cdp:sandbox` again.",
      "",
      "A live-mode key will answer 401 against the Sandbox; the modes are separate.",
      "The key file is a secret; never commit it or paste it into chat.",
    ].join("\n"),
  );
}

const keyFile = rawKey.startsWith("~")
  ? resolve(homedir(), rawKey.slice(1))
  : resolve(process.cwd(), rawKey);

if (!existsSync(keyFile)) {
  stop(`No CDP Sandbox key file at ${keyFile}. Fix CDP_API_KEY_FILE in .env.`);
}

try {
  const parsed = JSON.parse(readFileSync(keyFile, "utf8"));
  if (!parsed || typeof parsed !== "object") throw new Error("not a JSON object");
} catch {
  stop(`The file at ${keyFile} is not a CDP API key JSON object.`);
}

function run(args) {
  if (process.platform === "win32") {
    const quote = (value) => `"${String(value).replace(/"/g, '""')}"`;
    return spawnSync(["cdp", ...args].map(quote).join(" "), {
      shell: true,
      stdio: "inherit",
    });
  }
  return spawnSync("cdp", args, { stdio: "inherit" });
}

console.log(`Configuring CDP environment "${envName}"...`);
const envArgs = ["env", envName, "--key-file", keyFile];
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
