/**
 * Gate 729 — Prompt-optimization loop (DSPy-lite).
 *
 * Candidate instruction sets are manifest variants. Rank on the train split;
 * promote only on the dev split; touch the holdout exactly once for the final
 * report. Corpus-drift detection (gate 730) alerts when a retrained agent
 * shifts the holdout score distribution.
 */

import type { TrajectoryRecord } from "./trajectories.js";
import {
  trajectoryFromResult,
  exportJsonl,
  manifestHash,
} from "./trajectories.js";
import { splitBank, type ProbeRecord } from "./splits.js";

export interface Candidate {
  id: string;
  instruction: string;
  manifest: unknown;
}

export type ScorerFn = (
  output: string,
  probe: ProbeRecord,
) => { score: number; verdict: "PASS" | "VOID" | "FAIL"; detail: string; weights: Record<string, number> };

export interface PromptOptimizeConfig {
  candidates: Candidate[];
  temperature: number;
  seed: string;
  modelId: string;
  promptVersion: string;
}

export interface CandidateScore {
  id: string;
  instruction: string;
  trainAccuracy: number;
  devAccuracy: number;
  promoted: boolean;
}

export interface PromptOptimizeResult {
  winner: CandidateScore | null;
  all: CandidateScore[];
  holdoutAccuracy: number | null; // measured exactly once
}

/**
 * Run the DSPy-lite loop:
 *   1. Split bank into train/dev/holdout (deterministic, gate 726).
 *   2. For each candidate, sample completions on train; record train accuracy.
 *   3. Rank candidates on dev accuracy; promote the best.
 *   4. Touch holdout exactly once with the winner (gate 729).
 */
export async function promptOptimize(
  bank: ProbeRecord[],
  sampler: {
    sample(input: string, temperature: number, seed: string): Promise<{ output: string }>;
  },
  scorer: ScorerFn,
  config: PromptOptimizeConfig,
): Promise<PromptOptimizeResult> {
  const { train, dev, holdout } = splitBank(bank);

  const candidateScores: CandidateScore[] = [];

  for (const candidate of config.candidates) {
    let trainCorrect = 0;
    let trainTotal = 0;
    for (const probe of train) {
      const { output } = await sampler.sample(probe.prompt, config.temperature, config.seed);
      const { verdict } = scorer(output, probe);
      trainTotal += 1;
      if (verdict === probe.expectedVerdict) trainCorrect += 1;
    }
    const trainAccuracy = trainTotal > 0 ? trainCorrect / trainTotal : 0;

    let devCorrect = 0;
    let devTotal = 0;
    for (const probe of dev) {
      const { output } = await sampler.sample(probe.prompt, config.temperature, config.seed);
      const { verdict } = scorer(output, probe);
      devTotal += 1;
      if (verdict === probe.expectedVerdict) devCorrect += 1;
    }
    const devAccuracy = devTotal > 0 ? devCorrect / devTotal : 0;

    candidateScores.push({
      id: candidate.id,
      instruction: candidate.instruction,
      trainAccuracy,
      devAccuracy,
      promoted: false,
    });
  }

  // Rank on dev accuracy; promote the best.
  candidateScores.sort((a, b) => b.devAccuracy - a.devAccuracy);
  if (candidateScores.length > 0) {
    candidateScores[0]!.promoted = true;
  }

  // Touch holdout exactly once with the winner (gate 729).
  let holdoutAccuracy: number | null = null;
  const winner = candidateScores[0] ?? null;
  if (winner && holdout.length > 0) {
    let correct = 0;
    for (const probe of holdout) {
      const { output } = await sampler.sample(probe.prompt, config.temperature, config.seed);
      const { verdict } = scorer(output, probe);
      if (verdict === probe.expectedVerdict) correct += 1;
    }
    holdoutAccuracy = correct / holdout.length;
  }

  return { winner, all: candidateScores, holdoutAccuracy };
}

/** Export the promoted winner's trajectories over the whole bank as JSONL. */
export async function exportWinner(
  winner: CandidateScore | null,
  bank: ProbeRecord[],
  sampler: {
    sample(input: string, temperature: number, seed: string): Promise<{ output: string }>;
  },
  scorer: ScorerFn,
  config: PromptOptimizeConfig,
): Promise<TrajectoryRecord[]> {
  if (!winner) return [];

  const records: TrajectoryRecord[] = [];
  for (const probe of bank) {
    const { output } = await sampler.sample(probe.prompt, config.temperature, config.seed);
    const { score, verdict, detail, weights } = scorer(output, probe);
    records.push(
      trajectoryFromResult(
        probe.probeId,
        probe.prompt,
        output,
        verdict,
        score,
        detail,
        config.modelId,
        { instruction: winner.instruction },
        config.promptVersion,
        weights,
        "not-run",
        true,
        config.seed,
      ),
    );
  }

  const fs = await import("node:fs/promises");
  await fs.writeFile("winner.jsonl", exportJsonl(records), "utf8");
  return records;
}
