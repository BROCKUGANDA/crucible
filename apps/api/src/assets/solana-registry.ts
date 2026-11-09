/**
 * Solana Asset Registry adapter (Tokens API v1, server-side only).
 *
 * Registered-asset only: unregistered mints return asset_not_registered —
 * never retried, never fabricated. Risk grade is market-data enrichment, NOT
 * proof of reserves, ownership, or redemption rights.
 *
 * Docs: https://docs.tokens.xyz/v1
 */

const BASE = "https://api.tokens.xyz/v1";

function apiKey(): string | null {
  return process.env.TOKENS_API_KEY ?? null;
}

async function call<T>(path: string, init?: RequestInit): Promise<T> {
  const key = apiKey();
  if (!key) throw new Error("TOKENS_API_KEY is not configured (server-only)");
  const res = await fetch(`${BASE}${path}`, {
    ...init,
    headers: { "x-api-key": key, "content-type": "application/json", ...(init?.headers ?? {}) },
  });
  if (res.status === 404) {
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    const err = new Error(body.error ?? "asset_not_registered") as Error & { code: string };
    err.code = "asset_not_registered";
    throw err;
  }
  if (!res.ok) throw new Error(`tokens api ${res.status}`);
  return (await res.json()) as T;
}

export interface CanonicalAsset {
  assetId: string;
  mint: string;
  name?: string;
  symbol?: string;
  decimals?: number;
  classification?: string;
}

export async function resolveMint(mint: string): Promise<CanonicalAsset> {
  return call<CanonicalAsset>(`/assets/resolve?mint=${encodeURIComponent(mint)}`);
}

export async function searchAssets(query: string): Promise<CanonicalAsset[]> {
  return call<CanonicalAsset[]>(`/assets/search?q=${encodeURIComponent(query)}`);
}

export async function riskSummary(assetId: string): Promise<unknown> {
  return call<unknown>(`/assets/risk-summary?assetId=${encodeURIComponent(assetId)}`);
}

export async function marketSnapshots(mints: string[]): Promise<unknown> {
  if (mints.length > 250) throw new Error("batch limit is 250 mints");
  return call<unknown>(`/assets/market-snapshots`, {
    method: "POST",
    body: JSON.stringify({ mints }),
  });
}

export async function ohlcv(assetId: string, range: string): Promise<unknown> {
  return call<unknown>(`/assets/${encodeURIComponent(assetId)}/ohlcv?range=${encodeURIComponent(range)}`);
}

export function isAssetNotRegistered(err: unknown): boolean {
  return (err as { code?: string })?.code === "asset_not_registered";
}
