"use client";

import { useCallback, useEffect, useState } from "react";
import { API_BASE } from "./apiBase";

/**
 * The review queue — the cases waiting for a reviewer.
 *
 * The queue shows what the reviewer MAY take. A case the reviewer has a
 * recorded conflict with is not in the list at all: the platform refuses
 * it, and a queue that merely displayed it would be advice a reviewer in
 * a hurry ignores.
 *
 * The three things a reviewer may do about a case are the three the API
 * offers, and the page offers no fourth: take it, step away from it, or
 * declare a conflict of interest with it.
 */

export interface ReviewCase {
  trialId: number;
  sponsor: string;
  agent: string | null;
  status: string;
  specDigest: string;
  /** The reward in wei, as a string. Never a float on this side of the wire. */
  rewardWei: string;
  deadline: number;
  disclosed: boolean;
  state: ReviewerState;
}

export type ReviewerState =
  | { kind: "open" }
  | { kind: "yours"; claimedAt: number }
  | { kind: "held"; by: string; claimedAt: number }
  | { kind: "abstained"; reason: string; at: number };

export interface ReviewAbstention {
  trialId: number;
  reviewer: string;
  reason: string;
  abstainedAt: number;
}

export type ReviewQueueState =
  | { kind: "loading" }
  | { kind: "ready"; value: { cases: ReviewCase[]; abstentions: ReviewAbstention[] } }
  | { kind: "unreachable"; message: string };

/** The queue, as the reviewer sees it. */
export function useReviewQueue(refreshToken = 0): ReviewQueueState {
  const [state, setState] = useState<ReviewQueueState>({ kind: "loading" });

  useEffect(() => {
    let cancelled = false;
    setState({ kind: "loading" });
    fetch(`${API_BASE}/v1/reviews`, { credentials: "include" })
      .then(async (res) => {
        if (res.status === 401) {
          throw new Error("you are not signed in, so the queue cannot be read");
        }
        if (!res.ok) throw new Error(`the API answered ${res.status}`);
        return (await res.json()) as {
          cases: ReviewCase[];
          abstentions: ReviewAbstention[];
        };
      })
      .then((body) => {
        if (!cancelled) {
          setState({ kind: "ready", value: { cases: body.cases, abstentions: body.abstentions } });
        }
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        setState({
          kind: "unreachable",
          message: error instanceof Error ? error.message : "the API did not answer",
        });
      });
    return () => {
      cancelled = true;
    };
  }, [refreshToken]);

  return state;
}

/**
 * The three actions.
 *
 * A refusal is a refusal: the API answers with the reason and the page
 * shows it. A reviewer who is told "you have a recorded conflict of
 * interest with this trial's sponsor" learns something a queue that hid
 * the case never could.
 */
export function useReviewActions() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [refreshToken, setRefreshToken] = useState(0);

  const act = useCallback(async (path: string, body: unknown = {}) => {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`${API_BASE}/v1/reviews${path}`, {
        method: "POST",
        credentials: "include",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      const payload = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) {
        throw new Error(payload.error ?? `the API answered ${res.status}`);
      }
      setRefreshToken((token) => token + 1);
      return true;
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : "the action did not come back");
      return false;
    } finally {
      setBusy(false);
    }
  }, []);

  const claim = useCallback((trialId: number) => act(`/${trialId}/claim`), [act]);
  const abstain = useCallback(
    (trialId: number, reason: string) => act(`/${trialId}/abstain`, { reason }),
    [act],
  );
  const declareConflict = useCallback(
    (trialId: number, description: string) =>
      act(`/${trialId}/conflict`, { type: "employer", description }),
    [act],
  );

  return { busy, error, refreshToken, claim, abstain, declareConflict };
}
