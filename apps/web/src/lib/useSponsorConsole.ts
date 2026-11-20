"use client";

import { useCallback, useEffect, useState } from "react";
import { API_BASE } from "./apiBase";

/**
 * The sponsor console's reads and writes.
 *
 * Everything here talks to the API with the browser's session cookie, and
 * every answer keeps the API's own distinctions:
 *
 *   - a funding claim that the chain confirmed (`VERIFIED`);
 *   - a claim the chain read and contradicted (`MISMATCH`);
 *   - a claim the chain could not answer (`UNVERIFIABLE`).
 *
 * The console's job is to show all three. A console that showed only the
 * verified ones would report a programme as fully funded while money that was
 * claimed was never there.
 */

export type FundingVerdict = "VERIFIED" | "MISMATCH" | "UNVERIFIABLE";

export interface FundingClaim {
  id: string;
  programId: string;
  trialId: string;
  sponsorAddress: string;
  claimedWei: string;
  txHash: string | null;
  status: FundingVerdict | "CLAIMED";
  createdAt: number;
  updatedAt: number;
}

export interface FundingReceipt {
  claimId: string;
  verdict: FundingVerdict;
  reason: string | null;
  observedSponsorFundingWei: string | null;
  observedRewardWei: string | null;
  observedFeeWei: string | null;
  observedSponsor: string | null;
  trialStatus: number | null;
  checkedAt: number;
}

export interface FundingSummary {
  checked: number;
  verified: number;
  mismatched: number;
  unverifiable: number;
  verifiedWei: string;
  claimedWei: string;
}

export interface FundingStatus {
  programId: string;
  claims: FundingClaim[];
  receipts: FundingReceipt[];
  summary: FundingSummary;
}

export type ProgramSummary = {
  id: string;
  name: string;
  status: string;
  budget: {
    committed: string;
    deposited: string;
    escrowed: string;
    allocated: string;
    pending: string;
    payable: string;
    paid: string;
    withdrawn: string;
  };
};

export interface SponsorSummary {
  id: string;
  name: string;
  walletAddress: string;
  status: string;
}

/**
 * The sponsors the API knows about.
 *
 * The console matches these against the signed-in address itself: a sponsor
 * is a wallet, and the wallet that signed in is the one that can see its own
 * programmes. The API still owns membership — this is only how the console
 * knows WHICH sponsor record to ask about.
 */
export function useSponsors(enabled: boolean): ConsoleState<SponsorSummary[]> {
  const [state, setState] = useState<ConsoleState<SponsorSummary[]>>({ kind: "loading" });

  const load = useCallback(async () => {
    if (!enabled) {
      setState({ kind: "ready", value: [] });
      return;
    }
    setState({ kind: "loading" });
    const result = await readJson<SponsorSummary[]>("/sponsors");
    if (!result.ok) {
      setState(
        result.status === 0
          ? { kind: "unreachable", reason: result.reason }
          : { kind: "refused", status: result.status, reason: result.reason },
      );
      return;
    }
    setState({ kind: "ready", value: result.value });
  }, [enabled]);

  useEffect(() => {
    void load();
  }, [load]);

  return state;
}

export interface OrganisationSummary {
  id: string;
  name: string;
  slug?: string;
}

export type ConsoleState<T> =
  | { kind: "loading" }
  | { kind: "unreachable"; reason: string }
  | { kind: "refused"; status: number; reason: string }
  | { kind: "ready"; value: T };

async function readJson<T>(
  path: string,
  init?: RequestInit,
): Promise<{ ok: true; value: T } | { ok: false; status: number; reason: string }> {
  let res: Response;
  try {
    res = await fetch(`${API_BASE}${path}`, {
      credentials: "include",
      cache: "no-store",
      ...init,
    });
  } catch (err) {
    return {
      ok: false,
      status: 0,
      reason: err instanceof Error ? err.message : "the host could not be reached",
    };
  }
  let body: unknown = null;
  try {
    body = await res.json();
  } catch {
    body = null;
  }
  if (!res.ok) {
    const reason =
      body && typeof body === "object" && "error" in body
        ? String((body as { error: unknown }).error)
        : `the host answered with ${res.status}`;
    return { ok: false, status: res.status, reason };
  }
  return { ok: true, value: body as T };
}

/** The organisations the signed-in wallet belongs to. */
export function useOrganisations(enabled: boolean): ConsoleState<OrganisationSummary[]> {
  const [state, setState] = useState<ConsoleState<OrganisationSummary[]>>({ kind: "loading" });

  const load = useCallback(async () => {
    setState({ kind: "loading" });
    const result = await readJson<{ organisations?: OrganisationSummary[] }>("/orgs");
    if (!result.ok) {
      setState(
        result.status === 0
          ? { kind: "unreachable", reason: result.reason }
          : { kind: "refused", status: result.status, reason: result.reason },
      );
      return;
    }
    setState({ kind: "ready", value: result.value.organisations ?? [] });
  }, []);

  useEffect(() => {
    if (!enabled) return;
    void load();
  }, [enabled, load]);

  return state;
}

/** The programmes of one sponsor. */
export function usePrograms(
  sponsorId: string | null,
): ConsoleState<ProgramSummary[]> {
  const [state, setState] = useState<ConsoleState<ProgramSummary[]>>({ kind: "loading" });

  const load = useCallback(async () => {
    if (!sponsorId) {
      setState({ kind: "ready", value: [] });
      return;
    }
    setState({ kind: "loading" });
    const result = await readJson<ProgramSummary[]>(`/sponsors/${sponsorId}/programs`);
    if (!result.ok) {
      setState(
        result.status === 0
          ? { kind: "unreachable", reason: result.reason }
          : { kind: "refused", status: result.status, reason: result.reason },
      );
      return;
    }
    setState({ kind: "ready", value: result.value });
  }, [sponsorId]);

  useEffect(() => {
    void load();
  }, [load]);

  return state;
}

/** The funding status of one programme: claims, receipts and the two totals. */
export function useFundingStatus(
  programId: string | null,
  orgId: string | null,
  reloadToken: number,
): ConsoleState<FundingStatus> {
  const [state, setState] = useState<ConsoleState<FundingStatus>>({ kind: "loading" });

  const load = useCallback(async () => {
    if (!programId || !orgId) {
      setState({ kind: "ready", value: { programId: programId ?? "", claims: [], receipts: [], summary: emptySummary() } });
      return;
    }
    setState({ kind: "loading" });
    const result = await readJson<FundingStatus>(
      `/sponsors/programs/${encodeURIComponent(programId)}/funding?orgId=${encodeURIComponent(orgId)}`,
    );
    if (!result.ok) {
      setState(
        result.status === 0
          ? { kind: "unreachable", reason: result.reason }
          : { kind: "refused", status: result.status, reason: result.reason },
      );
      return;
    }
    setState({ kind: "ready", value: result.value });
  }, [programId, orgId]);

  useEffect(() => {
    void load();
  }, [load, reloadToken]);

  return state;
}

function emptySummary(): FundingSummary {
  return { checked: 0, verified: 0, mismatched: 0, unverifiable: 0, verifiedWei: "0", claimedWei: "0" };
}

/** Record what the programme claims it funded, and read the chain's answer. */
export async function recordFundingClaim(input: {
  programId: string;
  orgId: string;
  trialId: string;
  sponsorAddress: string;
  claimedWei: string;
  txHash?: string;
}): Promise<{ ok: true } | { ok: false; reason: string }> {
  const result = await readJson<{ receipt?: unknown }>(
    `/sponsors/programs/${encodeURIComponent(input.programId)}/funding/claims`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        orgId: input.orgId,
        trialId: input.trialId,
        sponsorAddress: input.sponsorAddress,
        claimedWei: input.claimedWei,
        txHash: input.txHash ?? undefined,
      }),
    },
  );
  if (!result.ok) return { ok: false, reason: result.reason };
  return { ok: true };
}

/** Ask the API to check every claim of a programme against the chain, now. */
export async function verifyFundingNow(
  programId: string,
  orgId: string,
): Promise<{ ok: true; checked: number } | { ok: false; reason: string }> {
  const result = await readJson<{ checked?: unknown[] }>(
    `/sponsors/programs/${encodeURIComponent(programId)}/funding/verify?orgId=${encodeURIComponent(orgId)}`,
    { method: "POST" },
  );
  if (!result.ok) return { ok: false, reason: result.reason };
  return { ok: true, checked: Array.isArray(result.value.checked) ? result.value.checked.length : 0 };
}
