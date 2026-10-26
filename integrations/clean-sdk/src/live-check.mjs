#!/usr/bin/env node
/**
 * Opt-in live check against Human Tech's public eligibility API.
 *
 * Not part of `npm test`: CI must not depend on a third party's uptime. Exits 1 only on a
 * transport failure; an ineligible wallet is a successful read and exits 0 with `eligible:false`.
 *
 *   npm run check:live -- 0x0000000000000000000000000000000000000001
 */
import { createEligibilitySource } from "./eligibility.mjs";

const address = process.argv[2];
if (!/^0x[0-9a-fA-F]{40}$/.test(address ?? "")) {
  console.error("usage: npm run check:live -- 0x-prefixed-20-byte-address");
  process.exit(2);
}

const source = createEligibilitySource({
  apiUrl: process.env.CLEAN_API_URL ?? "https://shield.human.tech",
  l1RpcUrl: process.env.L1_RPC_URL ?? "http://127.0.0.1:1",
  domain: process.env.CLEAN_DOMAIN ?? "localhost",
  timeoutMs: Number(process.env.CLEAN_LIVE_TIMEOUT_MS ?? 30_000),
});

try {
  const started = Date.now();
  const result = await source.check(address);
  console.log(JSON.stringify({ ...result, elapsedMs: Date.now() - started }, null, 2));
} catch (err) {
  console.error(`live check failed: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
}
