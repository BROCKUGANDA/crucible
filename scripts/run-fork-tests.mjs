#!/usr/bin/env node
/**
 * Run the opt-in ERC-8004 fork suite through the primary mainnet endpoint, then the fallback.
 *
 * A public node that answers `eth_chainId` may still prune the pinned block (measured:
 * publicnode failed the fork while drpc served it). The fallback is therefore only tried after
 * the primary fails, and the host that answered is printed either way.
 */
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";

const urls = [process.env.MAINNET_RPC_URL, process.env.MAINNET_RPC_FALLBACK_URL]
  .map((u) => (u ?? "").trim())
  .filter(Boolean);
if (urls.length === 0) {
  console.error("MAINNET_RPC_URL (and MAINNET_RPC_FALLBACK_URL) is not set; the fork suite is opt-in");
  process.exit(2);
}

const runner = resolve("scripts/run-forge.mjs");
for (const url of urls) {
  let host = "invalid URL";
  try {
    host = new URL(url).host;
  } catch {}
  console.log(`fork suite via ${host}`);
  const result = spawnSync(
    process.execPath,
    [runner, "test", "--fork-url", url, "--match-contract", "Fork", "-vv"],
    { cwd: "crucible-contracts", stdio: "inherit" },
  );
  if (result.status === 0) {
    console.log(`fork suite passed via ${host}`);
    process.exit(0);
  }
  console.error(`fork suite failed via ${host} (exit ${result.status}); trying the next endpoint`);
}
console.error("fork suite failed through every configured endpoint");
process.exit(1);
