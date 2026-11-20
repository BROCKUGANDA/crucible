"use client";

import { useCallback, useEffect, useState } from "react";
import { API_BASE } from "./apiBase";

/**
 * The published methods — the method card of a score.
 *
 * A number on its own says nothing about how it was measured. A published
 * method carries the suite it was measured against, the rubric with its
 * weights, the judge, the repetitions — and the LIMITS: what the score does
 * not establish.
 *
 * This module keeps the API's own distinctions, which are the whole point:
 *
 *   - two cards are COMPARABLE only when they were measured the same way;
 *   - "not comparable" is a verdict with a reason, not an error, and not a
 *     silent subtraction.
 */

/** A score in basis points. Never a float on this side of the wire. */
export type Bps = number;

export interface PublishedDimension {
  dimension: string;
  weightBps: number;
  methodology: string;
  scoreBps: number | null;
}

export interface PublishedMethod {
  id: string;
  subject: { kind: "run" | "trial"; id: string; agentId: string; agentVersion?: string };
  specDigest: string | null;
  /** What was measured, with the subject left out. Two scores may be
   * compared when this matches. */
  measurementKey: string;
  measurementKeySource: "spec" | "manifest";
  suite: {
    suiteId: string;
    name: string;
    versionId: string;
    version: string;
    specDigest: string;
    difficulty: string;
    evaluationProtocol: string;
    knownLimitations: string;
  } | null;
  rubric: {
    rubricId: string;
    name: string;
    status: string;
    dimensions: PublishedDimension[];
    aggregateBps: number | null;
    confidenceLowerBps: number | null;
    confidenceUpperBps: number | null;
    sampleCount: number;
    scoreStatus: string | null;
  };
  judge: {
    judgeVersion: string | null;
    runtimeImageDigest: string | null;
    environmentFingerprint: string | null;
    configDigest: string | null;
    modelId: string | null;
  };
  repetitions: {
    required: number;
    performed: number;
    agreed: boolean | null;
    agreementRule: string;
    replays: { replayNumber: number; workerIdentity: string; outputDigest: string | null; status: string }[];
  };
  limits: string[];
  comparabilityKey: string;
  digest: string;
  publishedAt: number;
}

export interface ComparisonVerdict {
  comparable: boolean;
  reason: string;
  differences: string[];
  left: {
    id: string;
    subject: { kind: "run" | "trial"; id: string; agentId: string; agentVersion?: string };
    measurementKey: string;
    suiteDigest: string | null;
    suiteVersion: string | null;
    rubricId: string;
    judgeVersion: string | null;
    aggregateBps: number | null;
    limits: number;
  };
  right: {
    id: string;
    subject: { kind: "run" | "trial"; id: string; agentId: string; agentVersion?: string };
    measurementKey: string;
    suiteDigest: string | null;
    suiteVersion: string | null;
    rubricId: string;
    judgeVersion: string | null;
    aggregateBps: number | null;
    limits: number;
  };
  recordedAt: number;
}

export type PublicationsState =
  | { kind: "loading" }
  | { kind: "ready"; value: PublishedMethod[] }
  | { kind: "unreachable"; message: string };

/** The published methods, newest first. */
export function usePublications(refreshToken = 0): PublicationsState {
  const [state, setState] = useState<PublicationsState>({ kind: "loading" });

  useEffect(() => {
    let cancelled = false;
    setState({ kind: "loading" });
    fetch(`${API_BASE}/v1/publications`)
      .then(async (res) => {
        if (!res.ok) throw new Error(`the API answered ${res.status}`);
        return (await res.json()) as { publications: PublishedMethod[] };
      })
      .then((body) => {
        if (!cancelled) setState({ kind: "ready", value: body.publications });
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

/** One published method. */
export function usePublication(id: string | null): PublicationsState {
  const [state, setState] = useState<PublicationsState>({ kind: "loading" });

  useEffect(() => {
    if (!id) return;
    let cancelled = false;
    setState({ kind: "loading" });
    fetch(`${API_BASE}/v1/publications/${encodeURIComponent(id)}`)
      .then(async (res) => {
        if (!res.ok) throw new Error(`the API answered ${res.status}`);
        return (await res.json()) as { publication: PublishedMethod };
      })
      .then((body) => {
        if (!cancelled) setState({ kind: "ready", value: [body.publication] });
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
  }, [id]);

  return state;
}

/**
 * Compare two published methods.
 *
 * The verdict is the API's, and "not comparable" is a normal answer: the
 * page shows the reason rather than hiding the comparison.
 */
export function useComparison() {
  const [verdict, setVerdict] = useState<ComparisonVerdict | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const compare = useCallback(async (a: string, b: string) => {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(
        `${API_BASE}/v1/publications/compare?a=${encodeURIComponent(a)}&b=${encodeURIComponent(b)}`,
      );
      if (!res.ok) throw new Error(`the API answered ${res.status}`);
      const body = (await res.json()) as { comparison: ComparisonVerdict };
      setVerdict(body.comparison);
    } catch (e: unknown) {
      setVerdict(null);
      setError(e instanceof Error ? e.message : "the comparison did not come back");
    } finally {
      setBusy(false);
    }
  }, []);

  return { verdict, busy, error, compare };
}

/** What a card is about, in words: the agent and its version. */
export function agentLabel(card: PublishedMethod): string {
  const version = card.subject.agentVersion ? ` @ ${card.subject.agentVersion}` : "";
  return `${card.subject.agentId}${version}`;
}

/**
 * A score in basis points, as a percentage with one decimal.
 *
 * A score the API did not report prints as an em dash, never as zero: zero
 * is a measurement, and nothing is not.
 */
export function formatBps(bps: number | null | undefined): string {
  if (bps === null || bps === undefined || !Number.isFinite(bps)) return "—";
  return `${(bps / 100).toFixed(1)}%`;
}
