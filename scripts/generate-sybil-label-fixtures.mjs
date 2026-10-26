#!/usr/bin/env node
/**
 * Regenerate the signed sybil-label fixture from a public, worthless test seed.
 *
 * The wallets are synthetic and the labels are a fixed alternating pattern. This fixture
 * exercises the label pipeline — signature verification, expiry, the class floor and the
 * refusal to treat a verdict as a label — not a claim about any real address. The issuer key
 * is derived from the public string below, so the fixture is reproducible without committing
 * a key or calling a network. It is not a production credential and must never be used as one.
 *
 *   node scripts/generate-sybil-label-fixtures.mjs
 *   node scripts/generate-sybil-label-fixtures.mjs --check
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { keccak256, toHex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { labelMessage } from "./label-identity-corpus.mjs";

const DIR = resolve("packages/datasets/fixtures/sybil-labels");
const COUNT = 80;
const ISSUED_AT = 1_799_999_400;
const EXPIRY = 1_800_086_400;
const SEED = keccak256(toHex("crucible.sybil-label.fixture.v1"));
const issuer = privateKeyToAccount(SEED);

function wallet(i) {
  return "0x" + i.toString(16).padStart(40, "0");
}

async function build() {
  const sheet = [];
  const proofs = [];
  const corpus = [];
  for (let i = 0; i < COUNT; i++) {
    const address = wallet(i);
    const label = i % 2;
    const features =
      label === 1
        ? { hasWonTrial: true, hasSlashes: false }
        : { hasWonTrial: false, hasSlashes: true };
    sheet.push({ wallet: address, agentId: i + 1, features, label: null });
    proofs.push({
      wallet: address,
      label,
      issuedAt: ISSUED_AT,
      expiry: EXPIRY,
      signature: await issuer.signMessage({ message: labelMessage(address, label, ISSUED_AT, EXPIRY) }),
    });
    corpus.push({ wallet: address, label, features, labelIssuer: issuer.address });
  }
  return {
    "issuer.txt": issuer.address,
    "sheet.jsonl": sheet.map((r) => JSON.stringify(r)).join("\n") + "\n",
    "proofs.jsonl": proofs.map((r) => JSON.stringify(r)).join("\n") + "\n",
    "corpus.jsonl":
      "# Labels are signed by a named issuer, never inferred from trial verdicts.\n" +
      corpus.map((r) => JSON.stringify(r)).join("\n") +
      "\n",
  };
}

const files = await build();

if (process.argv.includes("--check")) {
  let drift = 0;
  for (const [name, expected] of Object.entries(files)) {
    const actual = readFileSync(join(DIR, name), "utf8").replace(/\r\n/g, "\n");
    if (actual !== expected) {
      console.error(`fixture drift: ${name}`);
      drift += 1;
    }
  }
  if (drift) {
    console.error(`${drift} fixture file(s) differ; run npm run identity:fixtures`);
    process.exit(1);
  }
  console.log(`fixture matches (${COUNT} labels, issuer ${issuer.address})`);
} else {
  mkdirSync(DIR, { recursive: true });
  for (const [name, content] of Object.entries(files)) writeFileSync(join(DIR, name), content, "utf8");
  console.log(`wrote ${COUNT} labels to ${DIR} (issuer ${issuer.address})`);
}
