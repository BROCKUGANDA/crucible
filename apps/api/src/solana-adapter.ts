/**
 * Solana adapter — devnet only. Pure helpers; no secrets, no mainnet.
 *
 * Alchemy Solana sponsorship requires Enterprise access — do not depend on it.
 */

export const SOLANA_DEVNET_CLUSTER = "devnet";
export const SOLANA_MAINNET_CLUSTER = "mainnet-beta";

export function isDevnetCluster(cluster: string): boolean {
  return cluster === "devnet";
}

export type SolanaErrorKind = "timeout" | "blockhash_expired" | "insufficient_funds" | "invalid_signature" | "unknown";

export function classifySolanaError(err: unknown): SolanaErrorKind {
  const msg = (err instanceof Error ? err.message : String(err)).toLowerCase();
  if (msg.includes("timeout") || msg.includes("timed out")) return "timeout";
  if (msg.includes("blockhash") && msg.includes("expired")) return "blockhash_expired";
  if (msg.includes("insufficient") || msg.includes("lamports")) return "insufficient_funds";
  if (msg.includes("signature") && (msg.includes("invalid") || msg.includes("verification"))) return "invalid_signature";
  return "unknown";
}

export interface FeePayer {
  /** base58 pubkey of the fee payer */
  pubkey: string;
  /** whether this payer is a sponsor (pays on behalf of user) */
  sponsored: boolean;
}

export function canSponsor(feePayer: FeePayer, enterpriseAccess: boolean): boolean {
  return feePayer.sponsored && enterpriseAccess;
}
