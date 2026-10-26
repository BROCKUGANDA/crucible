#!/usr/bin/env node
/**
 * Fit the Sybil-risk coefficients from a labelled corpus, or verify the fitter on synthetic data.
 *
 *   node scripts/fit-identity.mjs --self-test
 *   node scripts/fit-identity.mjs --corpus out/identity-corpus.jsonl --out out/identity-posterior.json
 *
 * The corpus is JSONL, one wallet per line:
 *
 *   {"wallet": "0x…", "label": 1, "features": {"hasWonTrial": true, "identityLinked": true}}
 *
 * `label` is 1 for "this wallet belongs to a distinct person" and 0 for "duplicate or automated
 * identity". That label does not exist anywhere in this repository yet — trial verdicts are not
 * labels, and a slashed agent is not a sybil. Without a labelled corpus this script refuses; it
 * does not fall back to synthetic pretence. `scripts/export-identity-features.mjs` produces the
 * feature half of the file with `label: null`, which a human labels.
 *
 * Nothing here rewrites the scorer. The posterior is a candidate: promoting it into
 * `apps/api/src/identity.ts` is a reviewed code change made next to this output.
 */

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import {
  assertFittable,
  CorpusError,
  corpusDigest,
  FEATURES,
  fitHmc,
  gradNegLogPost,
  negLogPost,
  parseCorpus,
  rng,
} from "./lib/identity-fit.mjs";

function arg(name, fallback) {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : fallback;
}

function selfTest() {
  let failures = 0;
  const check = (label, ok, detail) => {
    console.log(`${ok ? "ok  " : "FAIL"}  ${label}${detail ? " — " + detail : ""}`);
    if (!ok) failures++;
  };

  // 1. The gradient must match a finite difference of the objective, or every trajectory is wrong.
  const rows = parseCorpus(
    [
      { wallet: "0x" + "01".repeat(20), label: 1, features: { hasWonTrial: true } },
      { wallet: "0x" + "02".repeat(20), label: 0, features: { hasSlashes: true } },
      { wallet: "0x" + "03".repeat(20), label: 1, features: { identityLinked: true, multipleTrials: true } },
    ]
      .map((r) => JSON.stringify(r))
      .join("\n"),
  );
  const beta = [0.3, -0.4, 0.7, 0.1, -0.2, 0.5, -0.6, 0.2, -1.1, 0.4, 0.9];
  const g = gradNegLogPost(rows, beta);
  const eps = 1e-6;
  let worst = 0;
  for (let i = 0; i < beta.length; i++) {
    const up = beta.slice();
    const down = beta.slice();
    up[i] += eps;
    down[i] -= eps;
    const fd = (negLogPost(rows, up) - negLogPost(rows, down)) / (2 * eps);
    worst = Math.max(worst, Math.abs(fd - g[i]) / Math.max(1, Math.abs(fd)));
  }
  check("analytic gradient matches finite differences", worst < 1e-5, `max rel err ${worst.toExponential(2)}`);

  // 2. Recovery: sample from a known model, fit it, and see the truth come back inside the CI.
  const truth = new Array(FEATURES.length).fill(0);
  truth[0] = -2.0; // intercept
  truth[6] = 1.5; // hasWonTrial
  truth[8] = -3.0; // hasSlashes
  const next = rng(7);
  const generated = [];
  for (let i = 0; i < 400; i++) {
    const features = {
      hasWonTrial: next() < 0.45,
      hasSlashes: next() < 0.2,
      identityLinked: next() < 0.5,
    };
    const x = FEATURES.map((name, idx) => (idx === 0 ? 1 : features[name] ? 1 : 0));
    let z = 0;
    for (let j = 0; j < truth.length; j++) z += truth[j] * x[j];
    const p = 1 / (1 + Math.exp(-z));
    generated.push({
      wallet: "0x" + i.toString(16).padStart(40, "0"),
      label: next() < p ? 1 : 0,
      features,
    });
  }
  const corpusText = generated.map((r) => JSON.stringify(r)).join("\n");
  const sample = parseCorpus(corpusText);
  assertFittable(sample);
  const fit = fitHmc(sample, { iterations: 2500, warmup: 1000, leapfrog: 12, seed: 11 });
  const pick = (i) => fit.coefficients[i];
  for (const [name, idx] of [
    ["intercept", 0],
    ["hasWonTrial", 6],
    ["hasSlashes", 8],
  ]) {
    const c = pick(idx);
    const covered = c.lo95 <= truth[idx] && truth[idx] <= c.hi95;
    check(
      `${name} recovers the generating coefficient`,
      Math.abs(c.mean - truth[idx]) < 0.6 && covered,
      `truth ${truth[idx].toFixed(2)}, posterior ${c.mean.toFixed(2)} [${c.lo95.toFixed(2)}, ${c.hi95.toFixed(2)}]`,
    );
  }
  check(
    "sampling acceptance stays in a healthy band",
    fit.diagnostics.samplingAcceptanceRate > 0.4 && fit.diagnostics.samplingAcceptanceRate < 0.99,
    `${(fit.diagnostics.samplingAcceptanceRate * 100).toFixed(1)}%`,
  );

  // 3. The refusals are part of the contract.
  const expectRefusal = (label, fn) => {
    try {
      fn();
      check(label, false, "accepted a corpus it should refuse");
    } catch (err) {
      check(label, err instanceof CorpusError, err.message);
    }
  };
  expectRefusal("refuses a corpus below the row floor", () => {
    assertFittable(sample.slice(0, 20));
  });
  expectRefusal("refuses an imbalanced corpus", () => {
    assertFittable(sample.filter((r) => r.y === 1));
  });
  expectRefusal("refuses a label that is not 0 or 1", () => {
    parseCorpus(JSON.stringify({ wallet: "0x" + "09".repeat(20), label: "yes", features: {} }));
  });
  expectRefusal("refuses an unknown feature name", () => {
    parseCorpus(JSON.stringify({ wallet: "0x" + "09".repeat(20), label: 1, features: { hasWonnTrial: true } }));
  });
  expectRefusal("refuses a wallet twice", () => {
    const w = "0x" + "0a".repeat(20);
    parseCorpus(
      [JSON.stringify({ wallet: w, label: 1, features: {} }), JSON.stringify({ wallet: w, label: 0, features: {} })].join("\n"),
    );
  });

  console.log(failures === 0 ? "\nSELF-TEST PASSED" : `\nSELF-TEST FAILED (${failures})`);
  return failures === 0;
}

async function main() {
  if (process.argv.includes("--self-test")) {
    process.exit(selfTest() ? 0 : 1);
  }

  const corpusPath = resolve(arg("--corpus", "out/identity-corpus.jsonl"));
  const outPath = resolve(arg("--out", "out/identity-posterior.json"));
  let text;
  try {
    text = readFileSync(corpusPath, "utf8");
  } catch (err) {
    if (err.code === "ENOENT") {
      console.error(
        `no corpus at ${corpusPath}\n\n` +
          "This fitter needs labelled data and will not invent it. Produce the feature half with:\n" +
          "  node scripts/export-identity-features.mjs --api http://127.0.0.1:8787\n" +
          "then label each line (1 = distinct person, 0 = duplicate/automated identity) and pass\n" +
          "the file with --corpus.",
      );
      process.exit(2);
    }
    throw err;
  }

  const rows = parseCorpus(text);
  assertFittable(rows);
  const fit = fitHmc(rows, {
    iterations: Number(arg("--iterations", "5000")),
    warmup: Number(arg("--warmup", "2000")),
    leapfrog: Number(arg("--leapfrog", "12")),
    seed: Number(arg("--seed", "1")),
  });

  const digest = corpusDigest(text);
  const result = {
    schemaVersion: 1,
    fittedAt: new Date().toISOString(),
    modelVersion: `bayesian-logistic-hmc-${digest.slice(0, 12)}`,
    corpus: { path: corpusPath, sha256: digest, ...fit.diagnostics },
    note: "Candidate posterior. Promoting it into apps/api/src/identity.ts is a reviewed code change.",
    ...fit,
  };
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, JSON.stringify(result, null, 2) + "\n", "utf8");

  console.log(`fit ${rows.length} rows (${fit.diagnostics.positives} positive)`);
  for (const c of fit.coefficients) {
    console.log(
      `  ${c.name.padEnd(18)} ${c.mean.toFixed(3).padStart(7)}  [${c.lo95.toFixed(3)}, ${c.hi95.toFixed(3)}]  sd ${c.sd.toFixed(3)}`,
    );
  }
  console.log(`acceptance ${(fit.diagnostics.samplingAcceptanceRate * 100).toFixed(1)}%  → ${outPath}`);
}

main().catch((err) => {
  console.error(err instanceof CorpusError ? `corpus rejected: ${err.message}` : err);
  process.exit(1);
});
