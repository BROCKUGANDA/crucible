#!/usr/bin/env node
/**
 * Turn an unlabelled feature sheet into a labelled corpus for the Sybil fitter.
 *
 *   node scripts/label-identity-corpus.mjs \
 *     --sheet out/identity-features.jsonl \
 *     --proofs out/labels.jsonl \
 *     --attestors 0xIssuer1,0xIssuer2 \
 *     --chain-now 1792872216 \
 *     --out out/identity-corpus.jsonl
 *
 * Labels come from a *signed statement by a named issuer*, not from a guess:
 *
 *   {"wallet":"0x…","label":1,"issuedAt":1792870000,"expiry":1792959000,"signature":"0x…"}
 *
 * where the issuer signed exactly (personal_sign, newline-joined):
 *
 *   Crucible label attestation
 *   wallet: 0x…
 *   label: 0|1
 *   issuedAt: N
 *   expiry: N
 *
 * Why not infer labels from trial outcomes: a slashed agent is not a sybil. Why not label
 * unattested wallets 0: absence of an attestation is not evidence of duplication, and a corpus
 * built that way would teach the model to equate "nobody vouched for this" with "this is a
 * farm" — the same mistake the faucet policy exists to avoid (ADR-0016).
 *
 * The script refuses unless a named issuer signed labels and both classes are present. With no
 * issuer named it prints exactly that and exits 2 — the corpus is not something this repository
 * can invent.
 */

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { verifyMessage } from "viem";

function arg(name, fallback) {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : fallback;
}

export function labelMessage(wallet, label, issuedAt, expiry) {
  return [
    "Crucible label attestation",
    `wallet: ${wallet.toLowerCase()}`,
    `label: ${label}`,
    `issuedAt: ${issuedAt}`,
    `expiry: ${expiry}`,
  ].join("\n");
}

function readJsonl(path) {
  return readFileSync(path, "utf8")
    .split(/\r?\n/)
    .filter((l) => l.trim() && !l.trim().startsWith("#"))
    .map((l, i) => {
      try {
        return JSON.parse(l);
      } catch (err) {
        throw new Error(`${path} line ${i + 1} is not JSON: ${err.message}`);
      }
    });
}

async function main() {
  const sheetPath = resolve(arg("--sheet", "out/identity-features.jsonl"));
  const proofsPath = resolve(arg("--proofs", "out/labels.jsonl"));
  const outPath = resolve(arg("--out", "out/identity-corpus.jsonl"));
  const attestors = (arg("--attestors", process.env.IDENTITY_ATTESTORS ?? ""))
    .split(",")
    .map((a) => a.trim())
    .filter((a) => /^0x[0-9a-fA-F]{40}$/.test(a));
  const chainNow = Number(arg("--chain-now", NaN));

  if (attestors.length === 0) {
    console.error(
      "no issuer is named (--attestors or IDENTITY_ATTESTORS).\n" +
        "Labels must be signed by someone this deployment trusts; this script will not invent them.",
    );
    process.exit(2);
  }
  if (!Number.isFinite(chainNow)) {
    console.error("--chain-now <unix seconds> is required: expiry is judged on the chain clock, not the host's.");
    process.exit(2);
  }
  let proofs;
  try {
    proofs = readJsonl(proofsPath);
  } catch (err) {
    console.error(`no label attestations at ${proofsPath}\n${err.message}`);
    process.exit(2);
  }
  const sheet = readJsonl(sheetPath);

  const byWallet = new Map();
  for (const p of proofs) {
    const wallet = String(p.wallet ?? "").toLowerCase();
    if (!/^0x[0-9a-f]{40}$/.test(wallet)) continue;
    byWallet.set(wallet, p);
  }

  const rows = [];
  const rejected = [];
  for (const row of sheet) {
    const wallet = String(row.wallet ?? "").toLowerCase();
    const p = byWallet.get(wallet);
    if (!p) continue;
    const label = p.label;
    if (label !== 0 && label !== 1) {
      rejected.push({ wallet, reason: "label must be 0 or 1" });
      continue;
    }
    let verified = false;
    for (const issuer of attestors) {
      try {
        verified = await verifyMessage({
          address: issuer,
          message: labelMessage(wallet, label, Number(p.issuedAt), Number(p.expiry)),
          signature: p.signature,
        });
      } catch {
        verified = false;
      }
      if (verified) break;
    }
    if (!verified) {
      rejected.push({ wallet, reason: "no named issuer signed this label" });
      continue;
    }
    if (Number(p.expiry) <= chainNow) {
      rejected.push({ wallet, reason: "label attestation expired" });
      continue;
    }
    rows.push({ wallet, label, features: row.features ?? {}, labelIssuer: attestors[0] });
  }

  const positives = rows.filter((r) => r.label === 1).length;
  const negatives = rows.length - positives;
  if (rows.length < 60 || positives < 15 || negatives < 15) {
    console.error(
      `only ${rows.length} labelled rows (${positives} human / ${negatives} sybil).\n` +
        "The fitter needs at least 60 rows with 15 of each class; a smaller corpus is refused there too.",
    );
    for (const r of rejected.slice(0, 5)) console.error(`  rejected ${r.wallet}: ${r.reason}`);
    process.exit(2);
  }

  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(
    outPath,
    "# Labels are signed by a named issuer, never inferred from trial verdicts.\n" +
      rows.map((r) => JSON.stringify(r)).join("\n") +
      "\n",
    "utf8",
  );
  console.log(`wrote ${rows.length} labelled rows (${positives} human / ${negatives} sybil) to ${outPath}`);
  if (rejected.length) console.log(`rejected ${rejected.length}: ${rejected[0].reason}${rejected.length > 1 ? " (and others)" : ""}`);
  console.log(`next: node scripts/fit-identity.mjs --corpus ${outPath}`);
}

main().catch((err) => {
  console.error(`labeling failed: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
