#!/usr/bin/env node
/**
 * Turn this deployment's own wallets into a labelling sheet for the Sybil fitter.
 *
 *   node scripts/export-identity-features.mjs --api http://127.0.0.1:8787
 *
 * It asks the API for each agent's evidence (`/identity/evidence/<wallet>`, the same collection
 * the score is computed from) and writes one JSONL row per wallet with `label: null`.
 *
 * Why this exists and why it stops there: the repo has no labelled sybil/human corpus, and this
 * script cannot create one — a label is a statement about who is behind a wallet, and nothing
 * on chain records that. What it can do is remove the tedious half: the features are already
 * computed by the service, so a labeller only has to fill in 0 or 1. Inventing those labels
 * would train the model on the wrong question, which is worse than shipping hand-tuned values.
 *
 * Every row is a wallet the index has seen as an agent operator. That is a biased sample of
 * faucet traffic — it says so in the summary rather than letting a future fitter assume it is a
 * random draw.
 */

import { writeFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";

const FEATURES = [
  "alloyTierIron",
  "alloyTierBronze",
  "alloyTierSteel",
  "alloyTierDamascus",
  "identityLinked",
  "hasWonTrial",
  "hasSurvivedBreak",
  "hasSlashes",
  "multipleTrials",
  "walletAgeOld",
];

function arg(name, fallback) {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : fallback;
}

async function getJson(url) {
  const res = await fetch(url, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(10000) });
  if (!res.ok) throw new Error(`${url} answered ${res.status}`);
  return res.json();
}

async function main() {
  const api = (arg("--api", process.env.IDENTITY_API_URL ?? "http://127.0.0.1:8787")).replace(/\/+$/, "");
  const outPath = resolve(arg("--out", "out/identity-features.jsonl"));

  const snapshot = await getJson(`${api}/snapshot`);
  const agents = Array.isArray(snapshot.agents) ? snapshot.agents : [];
  if (agents.length === 0) {
    console.error(
      "the index has no agents yet, so there is nothing to label.\n" +
        "Register an agent (or run the demo) and re-run; an empty sheet is not a corpus.",
    );
    process.exit(2);
  }

  const rows = [];
  const seen = new Set();
  for (const agent of agents) {
    const wallet = String(agent.operator ?? "").toLowerCase();
    if (!/^0x[0-9a-f]{40}$/.test(wallet) || seen.has(wallet)) continue;
    seen.add(wallet);
    let evidence;
    try {
      evidence = await getJson(`${api}/identity/evidence/${wallet}`);
    } catch (err) {
      console.error(`skipping ${wallet}: ${err instanceof Error ? err.message : String(err)}`);
      continue;
    }
    const present = new Set((evidence.evidence ?? []).map((e) => e.name));
    const features = Object.fromEntries(FEATURES.map((name) => [name, present.has(name)]));
    rows.push({ wallet, agentId: agent.id, features, label: null });
  }

  if (rows.length === 0) {
    console.error("every agent failed to produce evidence; nothing written");
    process.exit(1);
  }

  mkdirSync(dirname(outPath), { recursive: true });
  const body =
    "# One wallet per line. Fill `label`: 1 = a distinct person, 0 = duplicate or automated\n" +
    "# identity (several wallets one person controls to farm an allocation). Do not label from\n" +
    "# trial verdicts — a slashed agent is not a sybil. Then: node scripts/fit-identity.mjs\n" +
    rows.map((r) => JSON.stringify(r)).join("\n") +
    "\n";
  writeFileSync(outPath, body, "utf8");

  console.log(`wrote ${rows.length} unlabelled wallets to ${outPath}`);
  console.log("every label is null on purpose: labelling is a human judgment this repo cannot make");
  console.log(`source bias: agent operators from ${api}/snapshot, not a random sample of faucet traffic`);
}

main().catch((err) => {
  console.error(`export failed: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
