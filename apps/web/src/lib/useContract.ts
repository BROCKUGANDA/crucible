"use client";

import { useEffect, useState } from "react";
import { API_BASE } from "./apiBase";

/**
 * The API's contract, as the API published it.
 *
 * This is the whole point of the page that uses it: the numbers, the rules and
 * the error list come from `/v1/contract`, which the API builds from the same
 * modules that enforce them. A developer portal that writes its own copy of
 * the rate limit is a portal that will be wrong within a release.
 *
 * The failure modes are kept apart, because they mean different things to
 * somebody reading the page:
 *
 *   - `unreachable` — the host could not be reached;
 *   - `refused` — the host answered, and the answer was not a contract.
 *
 * Both print as an explanation. Neither prints as an empty catalogue, which
 * would read as "the API has no error codes" — the exact belief the page
 * exists to prevent.
 */
export type ContractState =
  | { kind: "loading" }
  | { kind: "unreachable"; reason: string }
  | { kind: "refused"; reason: string; status: number | null }
  | { kind: "ready"; contract: ApiContract };

export interface ApiContract {
  version: string;
  generatedAt: string;
  pagination: {
    style: string;
    parameters: { name: string; meaning: string }[];
    maxPage: number;
    response: { name: string; meaning: string }[];
    rule: string;
  };
  rateLimit: {
    limit: number;
    perMs: number;
    burst: number;
    scope: string;
    body: string;
  };
  authentication: {
    schemes: { name: string; how: string; use: string }[];
    rules: string[];
  };
  errors: {
    code: string;
    status: number;
    meaning: string;
    whatToDo: string;
  }[];
  webhooks: {
    signing: string;
    headers: { name: string; meaning: string }[];
    replayWindow: string;
  };
}

function isContract(body: unknown): body is ApiContract {
  if (body === null || typeof body !== "object") return false;
  const candidate = body as Partial<ApiContract>;
  return (
    typeof candidate.version === "string" &&
    Array.isArray(candidate.errors) &&
    Array.isArray(candidate.authentication?.schemes) &&
    typeof candidate.rateLimit?.limit === "number"
  );
}

export function useContract(): ContractState {
  const [state, setState] = useState<ContractState>({ kind: "loading" });

  useEffect(() => {
    let alive = true;
    const controller = new AbortController();

    void (async () => {
      try {
        const res = await fetch(`${API_BASE}/v1/contract`, { signal: controller.signal });
        let body: unknown = null;
        try {
          body = await res.json();
        } catch {
          body = null;
        }
        if (!alive) return;
        if (!res.ok) {
          setState({
            kind: "refused",
            status: res.status,
            reason: `The host answered with ${res.status} instead of a contract.`,
          });
          return;
        }
        if (!isContract(body)) {
          setState({
            kind: "refused",
            status: res.status,
            reason: "The host answered with something that is not a contract.",
          });
          return;
        }
        setState({ kind: "ready", contract: body });
      } catch (err) {
        if (!alive) return;
        setState({
          kind: "unreachable",
          reason: err instanceof Error ? err.message : String(err),
        });
      }
    })();

    return () => {
      alive = false;
      controller.abort();
    };
  }, []);

  return state;
}

/**
 * A rate limit in words a person can plan around.
 *
 * The API publishes a count per window; "60 per minute plus a burst of 20"
 * is what a client can actually do, and "60/min" is not.
 */
export function rateLimitInWords(rate: ApiContract["rateLimit"]): string {
  const seconds = Math.round(rate.perMs / 1000);
  const window = seconds === 1 ? "second" : `${seconds} seconds`;
  const burst = rate.burst > 0 ? `, plus a burst of ${rate.burst}` : "";
  return `${rate.limit} requests per ${window}${burst}`;
}
