/**
 * @file engrams.ts — the settlement -> achievement bridge.
 *
 * The achievement engine is keeper-gated and server-authoritative, and nothing
 * called it: entitlements could never be issued because no production event
 * source existed. After the warden settles a trial, this posts one verified
 * event built from the chain's own record (the read-model row the settlement
 * just moved), never from caller input.
 *
 * Posting never throws: a failed evaluation is a missing entitlement, not a
 * reason to stop settling trials.
 */

import type { ReadModel } from "@crucible/indexer";
import type { VerifiedEvent } from "@crucible/engrams";

export interface EngramsSyncOptions {
  /** Full endpoint, e.g. `http://api:8787/engrams/evaluate`. */
  url: string;
  /** `KEEPER_API_KEY` — the same bearer `/engrams/evaluate` verifies. */
  bearer: string;
  fetchImpl?: typeof fetch;
  onLog?: (line: string) => void;
}

export interface EngramsSync {
  /** Evaluate achievements for trials the sweep just settled. Returns how many posts were accepted. */
  afterSettlements(model: ReadModel, trialIds: readonly number[]): Promise<number>;
}

function argusVerdict(
  verdict: string,
): VerifiedEvent["argusVerdict"] {
  if (verdict === "paid") return "paid";
  if (verdict === "slashed") return "slashed";
  return undefined;
}

/**
 * The verified event for one settled trial, or null when the chain record
 * cannot support one (no operator, no verdict). The eventId is deterministic
 * per (trial, run): a replayed sweep or a second keeper posts the same id and
 * the engine's dedup answers "already issued" instead of minting twice.
 */
export function settledTrialEvent(model: ReadModel, trialId: number): VerifiedEvent | null {
  const trial = model.trials.get(trialId);
  if (!trial || trial.status !== "settled") return null;
  const agent = trial.agentId !== null ? model.agents.get(trial.agentId) : undefined;
  const recipient = agent?.operator;
  if (!recipient) return null;

  const survived =
    trial.verdict === "paid" && trial.breakSkeptic !== null;

  return {
    eventId: `settle:${trial.id}:${trial.runHash ?? "no-run"}`,
    eventType: survived ? "trial.broken-survived" : "trial.settled",
    verified: true,
    trialId: String(trial.id),
    runHash: trial.runHash ?? undefined,
    agentId: trial.agentId !== null ? String(trial.agentId) : undefined,
    operator: recipient,
    recipient,
    timestamp: (trial.settledAt ?? trial.createdAt) * 1000,
    argusVerdict: argusVerdict(trial.verdict),
  };
}

export function createEngramsSync(opts: EngramsSyncOptions): EngramsSync {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const log = opts.onLog ?? (() => {});

  return {
    async afterSettlements(model, trialIds) {
      let accepted = 0;
      for (const trialId of trialIds) {
        const event = settledTrialEvent(model, trialId);
        if (!event) {
          log(`trial ${trialId}: no settled agent record to evaluate; skipped`);
          continue;
        }
        try {
          const res = await fetchImpl(opts.url, {
            method: "POST",
            headers: {
              "content-type": "application/json",
              authorization: `Bearer ${opts.bearer}`,
            },
            body: JSON.stringify({ event, recipient: event.recipient }),
          });
          if (!res.ok) {
            log(`trial ${trialId}: evaluate answered ${res.status}`);
            continue;
          }
          accepted += 1;
        } catch (err) {
          log(`trial ${trialId}: evaluate failed: ${(err as Error).message}`);
        }
      }
      return accepted;
    },
  };
}
