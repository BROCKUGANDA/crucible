#!/usr/bin/env node
/**
 * T7 — the treasury release gate, evaluated against a reachable chain.
 *
 * One command, one JSON verdict. It checks the things a wrong deployment can get
 * silently wrong, on the chain that is actually reachable — the local demo chain
 * in CI, mainnet before launch:
 *
 *   1. treasury-destination: the escrow's on-chain treasury() equals the approved
 *      TREASURY_ADDRESS and is not the zero address. PR #63's deployment script
 *      demands contract code at both treasury and owner Safe; this gate re-reads
 *      the deployed contract instead of trusting the deploy log.
 *   2. fee-law: FEE_BPS is 500 (5%, ADR-0001) on the deployed contract itself.
 *   3. owner-boundary: the contract's owner is set and is not the zero address.
 *   4. conservation: address(trials).balance == totalStakes + totalPending + escrowed.
 *   5. reconciliation: the financial ledger (T4) replays and agrees with the chain
 *      when TRIALS_ADDRESS has settled anything; an empty history reconciles trivially.
 *
 * Usage:
 *   RPC_URL=http://127.0.0.1:8545 TRIALS_ADDRESS=0x… TREASURY_ADDRESS=0x… \
 *     node scripts/treasury-release-gate.mjs
 *
 * Exit 0 only when every check passes. Output is one JSON object.
 */
import { createPublicClient, http } from "viem";
import { foundry } from "viem/chains";
import { TRIALS_ABI } from "@crucible/smith";

const rpcUrl = process.env.RPC_URL ?? "http://127.0.0.1:8545";
const trialsAddress = process.env.TRIALS_ADDRESS;
const expectedTreasury = process.env.TREASURY_ADDRESS;

const norm = (a) => (typeof a === "string" ? a.toLowerCase() : a);
const read = async (client, functionName, args = []) =>
  await client.readContract({ address: trialsAddress, abi: TRIALS_ABI, functionName, args });

function verdict(ok, checks) {
  console.log(JSON.stringify({ gate: "treasury-release", ok, rpcUrl, trialsAddress, checks }, null, 2));
  process.exit(ok ? 0 : 1);
}

function fail(message) {
  console.error(JSON.stringify({ gate: "treasury-release", ok: false, error: message }, null, 2));
  process.exit(1);
}

if (!trialsAddress || !/^0x[0-9a-fA-F]{40}$/.test(trialsAddress)) {
  fail("TRIALS_ADDRESS must be set to the deployed escrow address");
}
if (!expectedTreasury || !/^0x[0-9a-fA-F]{40}$/.test(expectedTreasury)) {
  fail("TREASURY_ADDRESS must be set to the approved treasury (the company Safe on production)");
}

const client = createPublicClient({ chain: foundry, transport: http(rpcUrl) });
const checks = [];
const push = (name, ok, details) => checks.push({ name, ok, ...details });

try {
  const [chainTreasury, feeBps, owner, totalStakes, totalPending, escrowed, balance] = await Promise.all([
    read(client, "treasury"),
    read(client, "FEE_BPS"),
    read(client, "owner"),
    read(client, "totalStakes"),
    read(client, "totalPending"),
    read(client, "escrowed"),
    client.getBalance({ address: trialsAddress }),
  ]);

  const treasuryMatches = norm(chainTreasury) === norm(expectedTreasury);
  push("treasury-destination", treasuryMatches && chainTreasury !== "0x0000000000000000000000000000000000000000", {
    onChain: chainTreasury,
    approved: expectedTreasury,
    note: "the fee and slash destination is the configured company treasury, read back from the deployed contract",
  });

  push("fee-law", feeBps === 500n, {
    onChain: feeBps.toString(),
    note: "FEE_BPS is 500 (5 percent, ADR-0001); the 1500 bps Arena rate is a separate law (ADR-0011)",
  });

  push("owner-boundary", owner !== "0x0000000000000000000000000000000000000000", {
    onChain: owner,
    note: "the contract owner is an explicit configured address (ADR-0021), never silently the deployer",
  });

  const conservationOk = balance === totalStakes + totalPending + escrowed;
  push("conservation", conservationOk, {
    balanceWei: balance.toString(),
    totalStakesWei: totalStakes.toString(),
    totalPendingWei: totalPending.toString(),
    escrowedWei: escrowed.toString(),
  });

  // Reconciliation: replay the chain's money events into the ledger and compare.
  // Imported late so a missing ledger module cannot take the on-chain checks down.
  const { replayFinancialEvents, reconcile } = await import("../packages/indexer/dist/finance.js");
  const { appended, entries } = await replayFinancialEvents({
    rpcUrl,
    trialsAddress,
    treasury: chainTreasury,
    ledgerPath: process.env.FINANCE_LEDGER ?? ".finance/ledger.jsonl",
  });
  const report = await reconcile({ rpcUrl, trialsAddress, ledgerEntries: entries });
  push("reconciliation", report.ok, {
    appendedEntries: appended,
    totalEntries: entries.length,
    mismatches: report.mismatches,
    conservation: report.conservation,
  });

  verdict(checks.every((c) => c.ok), checks);
} catch (error) {
  fail(`gate could not reach the chain: ${error.message}`);
}
