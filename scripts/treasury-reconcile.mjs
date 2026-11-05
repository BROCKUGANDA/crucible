#!/usr/bin/env node
/**
 * T6 — treasury reconciliation against canonical chain evidence.
 *
 * Replays the escrow's money events (VerdictFinalized / Withdrawn) from the chain,
 * appends anything new to an append-only JSONL ledger, and compares the derived
 * books against the chain's own pull-ledger reads (credit per address) plus the
 * conservation identity. Prints a machine-readable verdict; exits non-zero on any
 * mismatch. It never edits an existing ledger line — a discrepancy is a finding,
 * and fixing one is a human decision with a correcting entry.
 *
 * Usage (local demo chain or mainnet — the chain decides, not the script):
 *   RPC_URL=http://127.0.0.1:8545 \
 *   TRIALS_ADDRESS=0x… TREASURY_ADDRESS=0x… \
 *   node scripts/treasury-reconcile.mjs [--ledger <path>] [--from-block N]
 *
 * Environment: RPC_URL (default local anvil), TRIALS_ADDRESS (required),
 * TREASURY_ADDRESS (required — the address the deployment configured as treasury),
 * FINANCE_LEDGER (default .finance/ledger.jsonl), FROM_BLOCK.
 */
import { resolve } from "node:path";
import { createPublicClient, http } from "viem";
import { foundry } from "viem/chains";
import { replayFinancialEvents, reconcile, readLedgerEntries } from "../packages/indexer/dist/finance.js";

const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] !== undefined ? process.argv[i + 1] : fallback;
};

const rpcUrl = process.env.RPC_URL ?? "http://127.0.0.1:8545";
const trialsAddress = process.env.TRIALS_ADDRESS;
const treasury = process.env.TREASURY_ADDRESS;
const ledgerPath = resolve(arg("ledger", process.env.FINANCE_LEDGER ?? ".finance/ledger.jsonl"));

function fail(message) {
  console.error(JSON.stringify({ gate: "treasury-reconcile", ok: false, error: message }, null, 2));
  process.exit(1);
}

if (!trialsAddress || !/^0x[0-9a-fA-F]{40}$/.test(trialsAddress)) {
  fail("TRIALS_ADDRESS must be set to the deployed escrow address");
}
if (!treasury || !/^0x[0-9a-fA-F]{40}$/.test(treasury)) {
  fail("TREASURY_ADDRESS must be set to the address the deployment configured as treasury");
}

const client = createPublicClient({ chain: foundry, transport: http(rpcUrl) });
const fromBlock = process.env.FROM_BLOCK ? BigInt(process.env.FROM_BLOCK) : 0n;

try {
  const { appended, entries } = await replayFinancialEvents({
    rpcUrl,
    trialsAddress,
    treasury,
    ledgerPath,
    fromBlock,
  });
  const report = await reconcile({
    rpcUrl,
    trialsAddress,
    ledgerEntries: entries,
  });
  const verdict = {
    gate: "treasury-reconcile",
    ok: report.ok,
    rpcUrl,
    trialsAddress,
    treasury,
    ledgerPath,
    appendedEntries: appended,
    totalEntries: entries.length,
    addresses: report.addresses,
    conservation: report.conservation,
    mismatches: report.mismatches,
  };
  if (!report.ok) {
    console.error(JSON.stringify(verdict, null, 2));
    process.exit(1);
  }
  console.log(JSON.stringify(verdict, null, 2));
} catch (error) {
  fail(`reconciliation could not run: ${error.message}`);
}
