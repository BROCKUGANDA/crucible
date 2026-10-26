/**
 * Offline fitter for the Sybil-risk scorer — Hamiltonian Monte Carlo, leapfrog integrator.
 *
 * Why a separate script and not a runtime dependency: the scorer ships hand-tuned likelihood
 * ratios (`apps/api/src/identity.ts`), and replacing them with fitted coefficients is a code
 * change that must be reviewable next to the corpus that produced it. This script writes a
 * candidate posterior; it never rewrites the scorer. That keeps one source of truth for β and
 * makes the promotion a deliberate step rather than something that happens on deploy.
 *
 * What HMC buys over a gradient step: a posterior, not a point. Each coefficient comes with a
 * standard deviation and a credible interval, so "hasSlashes = -3.1 [−4.0, −2.2]" can be
 * checked against the hand-picked −1.609 (LR 0.2) instead of silently replacing it.
 *
 * The model: logistic regression with a Gaussian prior N(0, 2.5²) on every coefficient,
 * intercept included. Feature order is fixed by FEATURES below, which mirrors the signal names
 * the scorer emits — the exporter writes those names, so the two cannot drift apart silently.
 *
 * A corpus is required and thin corpora are refused. There is no fallback to synthetic data and
 * no default labels: a posterior fitted to invented labels is worse than the hand-tuned values,
 * because it carries the appearance of measurement.
 */

import { createHash } from "node:crypto";

/** Feature names, in coefficient order. Intercept first. */
export const FEATURES = [
  "intercept",
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

export const PRIOR_SD = 2.5;
export const MIN_ROWS = 60;
export const MIN_PER_CLASS = 15;

export class CorpusError extends Error {
  constructor(message) {
    super(message);
    this.name = "CorpusError";
  }
}

// ── deterministic PRNG (mulberry32) ────────────────────────────────────────
export function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function gaussian(next) {
  // Box–Muller; `1 - u` keeps the log away from zero.
  const u = 1 - next();
  const v = next();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

function sigmoid(z) {
  return z >= 0 ? 1 / (1 + Math.exp(-z)) : Math.exp(z) / (1 + Math.exp(z));
}

function logSigmoid(z) {
  return z >= 0 ? -Math.log1p(Math.exp(-z)) : z - Math.log1p(Math.exp(z));
}

// ── corpus ─────────────────────────────────────────────────────────────────

/**
 * Parse and validate a labelled corpus.
 *
 * Each line: `{"wallet": "0x…", "label": 0|1, "features": {"hasWonTrial": true, …}}`.
 * Missing features are false. Unknown feature names are an error — a typo that silently became
 * a zero column is how a fit reports "no effect" about a signal nobody measured.
 */
export function parseCorpus(text) {
  const rows = [];
  const seen = new Set();
  const lines = text.split(/\r?\n/).filter((l) => l.trim() && !l.trim().startsWith("#"));
  for (const [i, line] of lines.entries()) {
    let obj;
    try {
      obj = JSON.parse(line);
    } catch (err) {
      throw new CorpusError(`line ${i + 1} is not JSON: ${err.message}`);
    }
    if (typeof obj.wallet !== "string" || !/^0x[0-9a-fA-F]{40}$/.test(obj.wallet)) {
      throw new CorpusError(`line ${i + 1}: wallet must be a 0x-prefixed 20-byte address`);
    }
    const key = obj.wallet.toLowerCase();
    if (seen.has(key)) throw new CorpusError(`line ${i + 1}: ${obj.wallet} appears twice`);
    seen.add(key);
    if (obj.label !== 0 && obj.label !== 1) {
      throw new CorpusError(`line ${i + 1}: label must be 0 or 1 (got ${JSON.stringify(obj.label)})`);
    }
    const features = obj.features && typeof obj.features === "object" ? obj.features : {};
    for (const name of Object.keys(features)) {
      if (!FEATURES.includes(name)) {
        throw new CorpusError(`line ${i + 1}: unknown feature ${JSON.stringify(name)}`);
      }
    }
    const x = FEATURES.map((name, idx) => (idx === 0 ? 1 : features[name] ? 1 : 0));
    rows.push({ wallet: key, y: obj.label, x });
  }
  return rows;
}

/** Refuse a corpus that cannot support a fit instead of producing a confident-looking poster. */
export function assertFittable(rows) {
  if (rows.length < MIN_ROWS) {
    throw new CorpusError(
      `corpus has ${rows.length} rows; at least ${MIN_ROWS} are required for a fit worth reporting`,
    );
  }
  const positives = rows.filter((r) => r.y === 1).length;
  const negatives = rows.length - positives;
  if (positives < MIN_PER_CLASS || negatives < MIN_PER_CLASS) {
    throw new CorpusError(
      `corpus has ${positives} positive / ${negatives} negative rows; at least ${MIN_PER_CLASS} of each are required`,
    );
  }
}

// ── the model ──────────────────────────────────────────────────────────────

/** Negative log posterior and its gradient. */
export function negLogPost(rows, beta) {
  let logLik = 0;
  let quad = 0;
  for (const b of beta) quad += b * b;
  for (const row of rows) {
    let z = 0;
    for (let i = 0; i < beta.length; i++) z += beta[i] * row.x[i];
    logLik += row.y === 1 ? logSigmoid(z) : logSigmoid(-z);
  }
  return -logLik + quad / (2 * PRIOR_SD * PRIOR_SD);
}

export function gradNegLogPost(rows, beta) {
  const g = beta.map((b) => b / (PRIOR_SD * PRIOR_SD));
  for (const row of rows) {
    let z = 0;
    for (let i = 0; i < beta.length; i++) z += beta[i] * row.x[i];
    const p = sigmoid(z);
    const d = p - row.y;
    for (let i = 0; i < beta.length; i++) g[i] += d * row.x[i];
  }
  return g;
}

// ── HMC ────────────────────────────────────────────────────────────────────

/**
 * Sample the posterior with HMC and a fixed-length leapfrog trajectory.
 *
 * Step size adapts during warm-up (dual averaging, target acceptance 0.8) and is frozen for
 * sampling: an adapting sampler during sampling produces a posterior whose spread is smaller
 * than the truth, which is exactly the number a reader would use to decide the fit is precise.
 */
export function fitHmc(rows, opts = {}) {
  const dim = FEATURES.length;
  const iterations = opts.iterations ?? 2500;
  const warmup = opts.warmup ?? 1000;
  const leapfrog = opts.leapfrog ?? 12;
  const seed = opts.seed ?? 1;
  const next = rng(seed);

  let q = new Array(dim).fill(0);
  let u = negLogPost(rows, q);
  const samples = [];
  let step = 0.25;
  let acceptStat = 0;
  let accepted = 0;
  let tries = 0;
  const mu = Math.log(10 * step);
  let hbar = 0;

  for (let it = 0; it < iterations + warmup; it++) {
    const p = Array.from({ length: dim }, () => gaussian(next));
    let qNew = q.slice();
    let g = gradNegLogPost(rows, qNew);
    let pNew = p.slice();
    for (let l = 0; l < leapfrog; l++) {
      // Half kick, full drift, half kick.
      for (let i = 0; i < dim; i++) pNew[i] -= (step / 2) * g[i];
      for (let i = 0; i < dim; i++) qNew[i] += step * pNew[i];
      g = gradNegLogPost(rows, qNew);
      for (let i = 0; i < dim; i++) pNew[i] -= (step / 2) * g[i];
    }
    const uNew = negLogPost(rows, qNew);
    let kineticOld = 0;
    let kineticNew = 0;
    for (let i = 0; i < dim; i++) {
      kineticOld += p[i] * p[i];
      kineticNew += pNew[i] * pNew[i];
    }
    const logAccept = -uNew + u - 0.5 * (kineticNew - kineticOld);
    tries++;
    if (Math.log(next()) < logAccept) {
      q = qNew;
      u = uNew;
      accepted++;
      if (it >= warmup) acceptStat++;
    }
    if (it < warmup) {
      // Nesterov dual averaging for the step size.
      const target = 0.8;
      const accept = Math.exp(Math.min(0, logAccept));
      hbar = (1 - 1 / (it + 1)) * hbar + (1 / (it + 1)) * (target - accept);
      const logStep = mu - (Math.sqrt(it + 1) / 0.05) * hbar;
      step = Math.exp(Math.min(Math.log(1.5), Math.max(Math.log(1e-4), logStep)));
    } else {
      samples.push(q.slice());
    }
  }

  const mean = new Array(dim).fill(0);
  for (const s of samples) for (let i = 0; i < dim; i++) mean[i] += s[i] / samples.length;
  const sd = new Array(dim).fill(0);
  for (const s of samples) for (let i = 0; i < dim; i++) sd[i] += (s[i] - mean[i]) ** 2 / (samples.length - 1);
  for (let i = 0; i < dim; i++) sd[i] = Math.sqrt(sd[i]);

  const quantile = (vals, q) => {
    const sorted = [...vals].sort((a, b) => a - b);
    const pos = (sorted.length - 1) * q;
    const lo = Math.floor(pos);
    const hi = Math.ceil(pos);
    return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
  };

  return {
    features: FEATURES,
    coefficients: FEATURES.map((name, i) => ({
      name,
      mean: mean[i],
      sd: sd[i],
      lo95: quantile(samples.map((s) => s[i]), 0.025),
      hi95: quantile(samples.map((s) => s[i]), 0.975),
    })),
    diagnostics: {
      rows: rows.length,
      positives: rows.filter((r) => r.y === 1).length,
      iterations,
      warmup,
      leapfrog,
      seed,
      finalStep: step,
      acceptanceRate: tries === 0 ? 0 : accepted / tries,
      samplingAcceptanceRate: samples.length === 0 ? 0 : acceptStat / samples.length,
    },
  };
}

/** A stable identity for a corpus, so a posterior can be tied to the data that produced it. */
export function corpusDigest(text) {
  return createHash("sha256").update(text, "utf8").digest("hex");
}
