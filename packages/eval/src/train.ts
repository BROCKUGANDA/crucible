/**
 * Gate 728 — Best-of-n training runner.
 *
 * The deterministic grader is the objective function. Per probe, sample n
 * completions (temperature and seed pinned in the agent manifest), keep the
 * top-scoring passing trajectory → SFT dataset; same-probe fail↔pass pairs →
 * DPO preference pairs.
 *
 * CLI: `bun run eval train --bank train.json --candidates dir/ --n 8`
 */

import { splitBank, type ProbeRecord, type SplitResult } from "./splits.js";
import type { TrajectoryRecord } from "./trajectories.js";
import {
  trajectoryFromResult,
  exportJsonl,
  manifestHash,
} from "./trajectories.js";

export interface Sample {
  probeId: string;
  input: string;
  output: string;
  score: number;
  verdict: "PASS" | "VOID" | "FAIL";
  detail: string;
  seed: string;
  temperature: number;
}

/** Completion sampler interface — the eval runner injects the real provider. */
export interface Sampler {
  sample(input: string, temperature: number, seed: string): Promise<{ output: string; latencyMs: number }>;
}

/** Score a sample with the deterministic grader's per-weight breakdown. */
export interface Scorer {
  score(output: string, probe: ProbeRecord): { score: number; verdict: "PASS" | "VOID" | "FAIL"; detail: string; weights: Record<string, number> };
}

export interface BestOfNConfig {
  n: number; // completions per probe
  temperature: number;
  seed: string; // pinned in the agent manifest (determinism ladder)
  modelId: string;
  manifest: unknown;
  promptVersion: string;
}

/** Result of the best-of-n run. */
export interface BestOfNResult {
  sft: TrajectoryRecord[]; // top-scoring passing trajectory per probe
  dpo: Array<{ probeId: string; chosen: TrajectoryRecord; rejected: TrajectoryRecord }>; // fail↔pass pairs
  skipped: string[]; // probes with no passing completion
}

/**
 * Run best-of-n over a bank. For each probe, sample n completions, score each,
 * keep the top-scoring passing one for SFT; emit fail↔pass pairs for DPO.
 */
export async function bestOfN(
  bank: ProbeRecord[],
  sampler: Sampler,
  scorer: Scorer,
  config: BestOfNConfig,
): Promise<BestOfNResult> {
  const sft: TrajectoryRecord[] = [];
  const dpo: BestOfNResult["dpo"] = [];
  const skipped: string[] = [];

  for (const probe of bank) {
    const samples: Sample[] = [];
    for (let i = 0; i < config.n; i++) {
      const { output } = await sampler.sample(probe.prompt, config.temperature, config.seed);
      const { score, verdict, detail, weights } = scorer.score(output, probe);
      samples.push({
        probeId: probe.probeId,
        input: probe.prompt,
        output,
        score,
        verdict,
        detail,
        seed: config.seed,
        temperature: config.temperature,
      });
    }

    // Passing samples, sorted by score desc.
    const passing = samples
      .filter((s) => s.verdict === "PASS")
      .sort((a, b) => b.score - a.score);

    // Failing samples, sorted by score asc (worst fail → best reject for DPO).
    const failing = samples
      .filter((s) => s.verdict !== "PASS")
      .sort((a, b) => a.score - b.score);

    if (passing.length === 0) {
      // No passing completion: skip SFT, but if there's a fail we can still form DPO pairs
      // only if we have both a pass and fail — we don't, so record as skipped.
      skipped.push(probe.probeId);
      continue;
    }

    const best = passing[0]!;
    const sftRecord = trajectoryFromResult(
      best.probeId,
      best.input,
      best.output,
      best.verdict,
      best.score,
      best.detail,
      config.modelId,
      config.manifest,
      config.promptVersion,
      weightsFromScore(best.score),
      "not-run",
      true,
      best.seed,
    );
    sft.push(sftRecord);

    // DPO: best passing vs worst failing (if any fail).
    if (failing.length > 0) {
      const worstFail = failing[0]!;
      dpo.push({
        probeId: probe.probeId,
        chosen: sftRecord,
        rejected: trajectoryFromResult(
          worstFail.probeId,
          worstFail.input,
          worstFail.output,
          worstFail.verdict,
          worstFail.score,
          worstFail.detail,
          config.modelId,
          config.manifest,
          config.promptVersion,
          weightsFromScore(worstFail.score),
          "not-run",
          true,
          worstFail.seed,
        ),
      });
    }
  }

  return { sft, dpo, skipped };
}

/** Derive a flat per-weight breakdown from a scalar score (placeholder — real impl splits by weight). */
function weightsFromScore(score: number): Record<string, number> {
  return { overall: score };
}

/** Write best-of-n results to disk as JSONL files. */
export async function writeResults(
  dir: string,
  result: BestOfNResult,
): Promise<{ sft: string; dpo: string; skipped: string }> {
  const fs = await import("node:fs/promises");
  const path = await import("node:path");
  const sftPath = path.join(dir, "sft.jsonl");
  const dpoPath = path.join(dir, "dpo.jsonl");
  const skippedPath = path.join(dir, "skipped.jsonl");

  await fs.writeFile(sftPath, exportJsonl(result.sft), "utf8");
  await fs.writeFile(dpoPath, JSON.stringify(result.dpo, null, 2) + "\n", "utf8");
  await fs.writeFile(skippedPath, result.skipped.join("\n") + (result.skipped.length ? "\n" : ""), "utf8");

  return { sft: sftPath, dpo: dpoPath, skipped: skippedPath };
}

/** Train split accessor — reuse the deterministic split (gate 726). */
export function trainSplit(bank: ProbeRecord[]): SplitResult {
  return splitBank(bank);
}
