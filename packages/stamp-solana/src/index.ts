/**
 * @file index.ts — the STAMP Solana barrel.
 *
 * Read-only chain observation and verification, plus the MetaDAO adapter whose
 * only shipped implementation is manual. Nothing here holds a key.
 */

export { base58Decode, base58Encode, isSolanaAddress } from "./base58.js";

export { decodeBase64, parseMintAccount, parseTokenAccount } from "./accounts.js";
export type { MintAccount, TokenAccount } from "./accounts.js";

export { HttpSolanaRpc, RpcError } from "./rpc.js";
export type {
  Commitment,
  RpcEndpointConfig,
  SignatureStatus,
  SolanaAccountInfo,
  SolanaRpc,
} from "./rpc.js";

export {
  TOKEN_PROGRAMS,
  verifyMint,
  verifyTransfer,
  verifyFinality,
  verifyLedgerAgreement,
  detectRpcDisagreement,
  verifyDelivery,
} from "./verification.js";
export type {
  CheckOutcome,
  VerificationOutcome,
  TransferObservation,
} from "./verification.js";

export { ManualMetaDaoAdapter, isUnsupported, validateEvidence } from "./metadao.js";
export type {
  CapabilityState,
  MetaDaoAdapter,
  MetaDaoCapabilities,
  MetaDaoProjectSnapshot,
  CanonicalTokenEvent,
  TreasurySnapshot,
  GovernanceLinks,
  EvidenceRecord,
} from "./metadao.js";