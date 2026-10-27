#!/usr/bin/env node
/**
 * Run the opt-in ERC-8004 fork suite through the primary mainnet endpoint, then the fallback.
 *
 * A public node that answers `eth_chainId` may still prune the pinned block (measured: publicnode
 * failed the fork while drpc served it), so the fallback is only tried after the primary fails.
 *
 * "Fails" used to mean only "forge exited non-zero", and that let a whole class of nothing through.
 * Measured on 2026-10-27 with a Sepolia endpoint as the primary: the chain check passed the way the
 * suite is *shaped* for an absent fork, all four tests printed `[SKIP]`, forge exited 0, and this
 * script announced "fork suite passed" without ever trying the fallback. A green that asserted
 * nothing is the failure mode HARDENING.md lists on its open items, so two things are now required
 * of an endpoint before it can be called a fork run:
 *
 *   1. it reports chain id 1 — checked here, with one RPC call, before compiling anything; and
 *   2. the suite actually runs: at least one passed test and zero skipped ones.
 *
 * Anything else moves to the next endpoint with the reason printed, and running out of endpoints is
 * a non-zero exit rather than a summary line.
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

const EXPECTED_CHAIN_ID = "0x1";

/**
 * One `eth_chainId` against the endpoint itself.
 *
 * Deliberately not `cast chain`: the point is to ask the remote the question the tests implicitly
 * ask it, cheaply and before any compilation, so a wrong-chain endpoint is named as such rather
 * than reported as a passing run. A node that does not answer is also a refusal — an endpoint we
 * cannot question is not one we should fork through.
 */
async function chainIdOf(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8_000);
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_chainId", params: [] }),
      signal: controller.signal,
    });
    if (!res.ok) return { ok: false, reason: `HTTP ${res.status}` };
    const body = (await res.json()).result;
    return typeof body === "string" ? { ok: true, id: body.toLowerCase() } : { ok: false, reason: "no result" };
  } catch (err) {
    return { ok: false, reason: err instanceof Error ? err.message : String(err) };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * The verdict of one fork run, from forge's own output rather than its exit code.
 *
 * `[SKIP]` is the tell. The four fork tests self-skip when they judge that no fork is attached, so
 * a run of four skips is a run that asserted nothing while looking exactly like a pass.
 */
function verdict(output) {
  const passed = (output.match(/\[PASS\]/g) ?? []).length;
  const skipped = (output.match(/\[SKIP\]/g) ?? []).length;
  const failed = (output.match(/\[FAIL\b/g) ?? []).length;
  return { passed, skipped, failed, ok: passed > 0 && skipped === 0 && failed === 0 };
}

const runner = resolve(process.cwd(), "scripts/run-forge.mjs");
const reasons = [];

for (const url of urls) {
  let host = "invalid URL";
  try {
    host = new URL(url).host;
  } catch {}

  const chain = await chainIdOf(url);
  if (!chain.ok) {
    reasons.push(`${host}: eth_chainId did not answer (${chain.reason})`);
    console.error(`fork suite not attempted via ${host} — ${reasons.at(-1)}`);
    continue;
  }
  if (chain.id !== EXPECTED_CHAIN_ID) {
    reasons.push(`${host}: eth_chainId is ${chain.id}, not ${EXPECTED_CHAIN_ID}`);
    console.error(`fork suite not attempted via ${host} — ${reasons.at(-1)}`);
    continue;
  }

  console.log(`fork suite via ${host} (chain id ${chain.id})`);
  const result = spawnSync(process.execPath, [runner, "test", "--fork-url", url, "--match-contract", "Fork", "-vv"], {
    cwd: "crucible-contracts",
    encoding: "utf8",
  });
  const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;
  // Printed rather than inherited so the same text can be judged below; a log the gate cannot read
  // is a log the gate cannot vouch for.
  process.stdout.write(output);

  if (result.error) {
    reasons.push(`${host}: could not run forge (${result.error.message})`);
    console.error(reasons.at(-1));
    continue;
  }

  const v = verdict(output);
  if (result.status !== 0) {
    reasons.push(`${host}: forge exited ${result.status} (${v.passed} passed, ${v.skipped} skipped, ${v.failed} failed)`);
    console.error(`fork suite failed via ${host} — ${reasons.at(-1)}; trying the next endpoint`);
    continue;
  }
  if (!v.ok) {
    reasons.push(`${host}: forge exited 0 but asserted nothing (${v.passed} passed, ${v.skipped} skipped)`);
    console.error(`fork suite not accepted from ${host} — ${reasons.at(-1)}; trying the next endpoint`);
    continue;
  }

  console.log(`fork suite passed via ${host}: ${v.passed} tests, none skipped`);
  process.exit(0);
}

console.error(`fork suite failed through every configured endpoint:\n  ${reasons.join("\n  ")}`);
process.exit(1);
