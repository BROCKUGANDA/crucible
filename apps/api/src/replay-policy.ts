/**
 * @file replay-policy.ts — the three-replay rule, in one place.
 *
 * The rule is simple: an evaluation's result is reproducible when three
 * INDEPENDENT replays of the same pinned task agree. One run proves what
 * happened once; two can agree by coincidence.
 *
 * This constant used to live in two places — `studio-routes.ts` and the
 * default repetition policy of `evaluation-spec.ts` — which is how a rule
 * ends up enforced with three replays in one place and two in another. The
 * rule is one rule.
 *
 * Three is not a tuning knob. It is the smallest number of independent
 * observations from which "they agree" means something.
 */
export const REQUIRED_REPLAYS = 3;

/**
 * How many DIFFERENT workers the replays must come from.
 *
 * The rule is about INDEPENDENCE, not about counting: one worker running
 * the same verifier three times can agree three times and still be wrong
 * three times — a sticky seed, a cached artefact, a bug in that worker.
 * Two workers can lose the same way. So the number of replays and the
 * number of workers are two separate thresholds, and the second one is the
 * one that makes the first mean something.
 *
 * It equals the number of replays: three observations from three workers.
 */
export const REQUIRED_REPLAY_WORKERS = REQUIRED_REPLAYS;

/** The repetition policy a spec gets when the caller names none. */
export const DEFAULT_REPETITION_POLICY = {
  repetitions: 1,
  independentReplays: REQUIRED_REPLAYS,
} as const;
