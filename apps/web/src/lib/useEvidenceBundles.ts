"use client";

import { useEffect, useState } from "react";
import { API_BASE } from "./apiBase";

/**
 * The frozen evidence of a dispute.
 *
 * A bundle is what a committee reads: what the chain committed to, what the
 * platform measured, and — stated in the bundle itself — what is MISSING
 * from it. The gaps matter as much as the contents: a bundle that
 * silently omitted the replay manifest would read as a bundle in which the
 * run did not happen.
 *
 * The bundle is content-addressed, so its digest can be recomputed and
 * checked. The page says so instead of asking to be trusted.
 */

export interface BundleChainFacts {
  trialId: number | null;
  sponsor: string | null;
  status: string | null;
  verdict: string | null;
  specDigest: string | null;
  testsDigest: string | null;
  disclosedSpecCid: string | null;
  disclosedTestsCid: string | null;
  breakSkeptic: string | null;
  breakProofCid: string | null;
  disputeOpenedAt: number | null;
}

export interface BundleMeasurement {
  pinnedSpecDigest: string | null;
  measurementKey: string | null;
  manifestIds: string[];
  replays: {
    manifestId: string;
    replayNumber: number;
    workerIdentity: string;
    outputDigest: string | null;
    status: string;
  }[];
  replaysAgreed: boolean | null;
  dimensions: { dimension: string; weightBps: number; scoreBps: number | null }[];
  aggregateBps: number | null;
  confidenceLowerBps: number | null;
  confidenceUpperBps: number | null;
  sampleCount: number;
  scoreStatus: string | null;
  publicationId: string | null;
}

export interface EvidenceBundle {
  id: string;
  trialKey: string;
  sealedAt: number;
  chain: BundleChainFacts | null;
  measurement: BundleMeasurement;
  gaps: string[];
  digest: string;
}

export interface StoredBundleSummary {
  id: string;
  sealedAt: number;
  predatesDispute: boolean | null;
  digest: string;
  gaps: number;
}

export type BundlesState =
  | { kind: "loading" }
  | { kind: "ready"; value: StoredBundleSummary[] }
  | { kind: "unreachable"; message: string };

/** The bundles sealed for a trial, oldest first. */
export function useEvidenceBundles(trialId: string | null): BundlesState {
  const [state, setState] = useState<BundlesState>({ kind: "loading" });

  useEffect(() => {
    if (!trialId) return;
    let cancelled = false;
    setState({ kind: "loading" });
    fetch(`${API_BASE}/v1/disputes/${encodeURIComponent(trialId)}/bundles`)
      .then(async (res) => {
        if (!res.ok) throw new Error(`the API answered ${res.status}`);
        return (await res.json()) as { bundles: StoredBundleSummary[] };
      })
      .then((body) => {
        if (!cancelled) setState({ kind: "ready", value: body.bundles });
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
  }, [trialId]);

  return state;
}

/** One frozen bundle, by its address. */
export function useEvidenceBundle(id: string | null): {
  state: "loading" | "ready" | "unreachable";
  bundle: EvidenceBundle | null;
  predatesDispute: boolean | null;
} {
  const [state, setState] = useState<"loading" | "ready" | "unreachable">("loading");
  const [bundle, setBundle] = useState<EvidenceBundle | null>(null);
  const [predates, setPredates] = useState<boolean | null>(null);

  useEffect(() => {
    if (!id) return;
    let cancelled = false;
    setState("loading");
    fetch(`${API_BASE}/v1/disputes/bundles/${encodeURIComponent(id)}`)
      .then(async (res) => {
        if (!res.ok) throw new Error(`the API answered ${res.status}`);
        return (await res.json()) as {
          bundle: EvidenceBundle;
          predatesDispute: boolean | null;
        };
      })
      .then((body) => {
        if (cancelled) return;
        setBundle(body.bundle);
        setPredates(body.predatesDispute);
        setState("ready");
      })
      .catch(() => {
        if (!cancelled) setState("unreachable");
      });
    return () => {
      cancelled = true;
    };
  }, [id]);

  return { state, bundle, predatesDispute: predates };
}

/** A score in basis points. An unknown amount prints as an em dash, never a zero. */
export function formatBps(bps: number | null | undefined): string {
  if (bps === null || bps === undefined || !Number.isFinite(bps)) return "—";
  return `${(bps / 100).toFixed(1)}%`;
}
