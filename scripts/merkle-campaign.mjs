#!/usr/bin/env node
/**
 * merkle-campaign.mjs — Off-chain Merkle proof generator for Engram campaigns.
 *
 * Input: a JSON file with shape:
 *   { "campaignId": "0", "leaves": [ { "recipient": "0x...", "amount": "1" }, ... ] }
 *
 * Output: writes <out>.json with { root, leaves, proofs: { leaf: [proof,...] } }.
 *
 * Usage:
 *   node scripts/merkle-campaign.mjs --in campaign.json --out proofs.json
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const args = process.argv.slice(2);
function arg(name, fallback) {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : fallback;
}

const inFile = arg('--in', null);
const outFile = arg('--out', 'merkle-proofs.json');
if (!inFile) {
  console.error('usage: node merkle-campaign.mjs --in <campaign.json> [--out <proofs.json>]');
  process.exit(2);
}

const { buildMerkleTree } = await import('../packages/engrams/dist/merkle.js');

const raw = JSON.parse(readFileSync(resolve(inFile), 'utf8'));
const campaignId = BigInt(raw.campaignId ?? 0);
const leaves = (raw.leaves ?? []).map((l) => ({
  recipient: l.recipient,
  amount: BigInt(l.amount ?? 1),
  campaignId,
}));

const tree = buildMerkleTree(leaves);
const proofs = {};
for (const [leaf, proof] of tree.proofs.entries()) {
  proofs[leaf] = proof;
}

const out = { root: tree.root, leaves: tree.leaves, proofs };
writeFileSync(resolve(outFile), JSON.stringify(out, null, 2));
console.log('root:', tree.root);
console.log('leaves:', tree.leaves.length);
console.log('wrote:', resolve(outFile));
