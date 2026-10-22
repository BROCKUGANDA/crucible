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
 * The key itself is never printed: the request headers shown here are the ones
 * the CLI echoed for that call, with credential-bearing values redacted.
 */
import { api, cdpConfig, configure, credentialProblem, findCdpBin, header } from "./lib/cdp-cli.mjs";

const cfg = cdpConfig();
const problem = credentialProblem(cfg);
if (problem) {
  console.error(problem);
  process.exit(2);
}

const bin = findCdpBin();
console.log(`Configuring CDP environment "${cfg.envName}" (${cfg.baseUrl})...`);
const configured = configure(cfg, bin);
if (configured.status !== 0) {
  console.error(
    "Could not configure the CDP environment. Is `@coinbase/cdp-cli` installed? " +
      "Run `npm i -g @coinbase/cdp-cli` and try again.",
  );
  process.exit(configured.status ?? 1);
}

console.log(`Listing ${cfg.envName} accounts...`);
// The long form from the CDP quickstart; the short `accounts balance` form is
// not present in every CLI version, and `/platform/v2` must be explicit.
try {
  api(cfg, bin, ["/platform/v2/accounts", header("X-Crucible-Run", "cdp-sandbox")]);
} catch (error) {
  console.error(`\n${error.message}`);
  process.exit(1);
}

console.log(
  "\nIf the list is empty, create and fund a Sandbox account in the CDP Portal " +
    "(Sandbox -> Accounts). Its balances are simulated USD/USDC/USDT; no real funds " +
    "or testnet assets can be sent to it.",
);
