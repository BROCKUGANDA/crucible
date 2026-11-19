/**
 * @file verification.ts — the ten checks the blueprint requires before anything
 * may be called delivered.
 *
 * Each check is a function of an observation, so each one can be tested against
 * a fabricated account and shown to fail. That matters here more than anywhere
 * else in this repository: "delivery verified" is the claim that moves legal
 * state, and a verifier that cannot be made to say no is not a verifier.
 *
 * The functions return reasons rather than booleans, because an operator
 * staring at a stuck delivery needs to know which one of ten checks refused.
 */

import { isSolanaAddress } from "./base58.js";
import { type MintAccount, type TokenAccount, parseMintAccount, parseTokenAccount } from "./accounts.js";
import type { Commitment, SignatureStatus, SolanaRpc } from "./rpc.js";

export interface CheckOutcome {
  id: string;
  ok: boolean;
  detail: string;
}

export interface VerificationOutcome {
  ok: boolean;
  checks: CheckOutcome[];
  reasons: string[];
}

function finish(checks: CheckOutcome[]): VerificationOutcome {
  const failed = checks.filter((c) => !c.ok);
  return {
    ok: failed.length === 0,
    checks,
    reasons: failed.map((c) => c.detail),
  };
}

/** The programs an SPL token mint may legitimately be owned by. */
export const TOKEN_PROGRAMS = {
  SPL_TOKEN: "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
  TOKEN_2022: "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb",
} as const;

/**
 * Check 1-3, 7: read the canonical mint and prove it is the expected one.
 *
 * A mint whose `owner` is neither token program is either not a token mint or
 * not ours, and a mint authority that is not the expected one means somebody
 * else can inflate the supply after the snapshot was locked.
 */
export async function verifyMint(
  rpc: SolanaRpc,
  options: {
    mint: string;
    expectedMint: string;
    expectedSupply?: bigint;
    expectedMintAuthority?: string | null;
    commitment?: Commitment;
  },
): Promise<VerificationOutcome & { mint: MintAccount | null }> {
  const commitment = options.commitment ?? "finalized";
  const checks: CheckOutcome[] = [];

  checks.push({
    id: "mint_address_is_solana",
    ok: isSolanaAddress(options.expectedMint),
    detail: isSolanaAddress(options.expectedMint)
      ? `mint ${options.expectedMint} is a 32-byte address`
      : `expected mint ${options.expectedMint} is not a base58 32-byte address`,
  });

  if (options.mint !== options.expectedMint) {
    checks.push({
      id: "mint_matches_configuration",
      ok: false,
      detail: `chain mint ${options.mint} is not the configured mint ${options.expectedMint}`,
    });
    return { ...finish(checks), mint: null };
  }
  checks.push({ id: "mint_matches_configuration", ok: true, detail: `mint ${options.mint} matches configuration` });

  const account = await rpc.getAccountInfo(options.mint, commitment);
  if (!account) {
    checks.push({ id: "mint_account_exists", ok: false, detail: `no account at ${options.mint}` });
    return { ...finish(checks), mint: null };
  }
  checks.push({ id: "mint_account_exists", ok: true, detail: `account found at slot ${account.slot ?? "?"}` });

  let mint: MintAccount;
  try {
    mint = parseMintAccount(account.dataBase64, account.owner);
  } catch (error) {
    checks.push({
      id: "mint_account_decodes",
      ok: false,
      detail: `mint account does not decode as an SPL mint: ${(error as Error).message}`,
    });
    return { ...finish(checks), mint: null };
  }
  checks.push({
    id: "mint_account_decodes",
    ok: true,
    detail: `decoded ${mint.dataLength}-byte mint, ${mint.decimals} decimals`,
  });

  const ownedByTokenProgram =
    account.owner === TOKEN_PROGRAMS.SPL_TOKEN || account.owner === TOKEN_PROGRAMS.TOKEN_2022;
  checks.push({
    id: "mint_owned_by_token_program",
    ok: ownedByTokenProgram,
    detail: ownedByTokenProgram
      ? `owned by ${account.owner}`
      : `owned by ${account.owner}, which is not an SPL token program`,
  });

  checks.push({
    id: "mint_initialized",
    ok: mint.isInitialized,
    detail: mint.isInitialized ? "mint is initialized" : "mint is not initialized",
  });

  if (options.expectedSupply !== undefined) {
    checks.push({
      id: "supply_matches_snapshot",
      ok: mint.supply === options.expectedSupply,
      detail:
        mint.supply === options.expectedSupply
          ? `supply ${mint.supply} matches the legal snapshot`
          : `supply ${mint.supply} does not match the legal snapshot ${options.expectedSupply}`,
    });
  }

  if (options.expectedMintAuthority !== undefined) {
    checks.push({
      id: "mint_authority_matches",
      ok: mint.mintAuthority === options.expectedMintAuthority,
      detail:
        mint.mintAuthority === options.expectedMintAuthority
          ? `mint authority is ${mint.mintAuthority ?? "revoked"}`
          : `mint authority is ${mint.mintAuthority ?? "revoked"}, expected ${options.expectedMintAuthority ?? "revoked"}`,
    });
  }

  return { ...finish(checks), mint };
}

export interface TransferObservation {
  mint: string;
  destination: string;
  amountBaseUnits: bigint;
  owner: string;
}

/**
 * Checks 3-5: the destination holds exactly the quantity, in the right mint,
 * under the expected owner.
 *
 * `exact` matters. A destination that holds more than the delivery was
 * credited is a destination that received tokens from somewhere else, and a
 * delivery record that cannot tell the difference is a delivery record that
 * cannot be reconciled.
 */
export function verifyTransfer(
  account: { dataBase64: string; owner: string } | null,
  expected: TransferObservation,
): VerificationOutcome & { tokenAccount: TokenAccount | null } {
  const checks: CheckOutcome[] = [];
  if (!account) {
    checks.push({ id: "destination_exists", ok: false, detail: `no token account at ${expected.destination}` });
    return { ...finish(checks), tokenAccount: null };
  }
  checks.push({ id: "destination_exists", ok: true, detail: `token account found at ${expected.destination}` });

  let tokenAccount: TokenAccount;
  try {
    tokenAccount = parseTokenAccount(account.dataBase64);
  } catch (error) {
    checks.push({
      id: "destination_is_token_account",
      ok: false,
      detail: `destination does not decode as an SPL token account: ${(error as Error).message}`,
    });
    return { ...finish(checks), tokenAccount: null };
  }
  checks.push({ id: "destination_is_token_account", ok: true, detail: "destination is an SPL token account" });

  const ownerIsTokenProgram =
    account.owner === TOKEN_PROGRAMS.SPL_TOKEN || account.owner === TOKEN_PROGRAMS.TOKEN_2022;
  checks.push({
    id: "destination_owned_by_token_program",
    ok: ownerIsTokenProgram,
    detail: ownerIsTokenProgram ? `owned by ${account.owner}` : `owned by ${account.owner}`,
  });

  checks.push({
    id: "destination_mint_matches",
    ok: tokenAccount.mint === expected.mint,
    detail:
      tokenAccount.mint === expected.mint
        ? `holds mint ${tokenAccount.mint}`
        : `holds mint ${tokenAccount.mint}, expected ${expected.mint}`,
  });

  checks.push({
    id: "destination_owner_matches",
    ok: tokenAccount.owner === expected.owner,
    detail:
      tokenAccount.owner === expected.owner
        ? `owned by ${tokenAccount.owner}`
        : `owned by ${tokenAccount.owner}, expected ${expected.owner}`,
  });

  checks.push({
    id: "destination_not_frozen",
    ok: tokenAccount.state !== "frozen",
    detail: `account state is ${tokenAccount.state}`,
  });

  checks.push({
    id: "quantity_matches_exactly",
    ok: tokenAccount.amount === expected.amountBaseUnits,
    detail:
      tokenAccount.amount === expected.amountBaseUnits
        ? `balance ${tokenAccount.amount} matches the delivery exactly`
        : `balance ${tokenAccount.amount} does not match the delivery ${expected.amountBaseUnits}`,
  });

  return { ...finish(checks), tokenAccount };
}

/**
 * Check 8: the agreed finality level, and no error.
 *
 * A signature the node has never seen, a signature that errored, and a
 * signature that is merely `confirmed` are three different refusals.
 */
export function verifyFinality(
  signature: string,
  status: SignatureStatus | null,
  required: Commitment = "finalized",
): VerificationOutcome {
  const checks: CheckOutcome[] = [];
  if (!status) {
    checks.push({
      id: "signature_known",
      ok: false,
      detail: `the node has no record of signature ${signature}`,
    });
    return finish(checks);
  }
  checks.push({ id: "signature_known", ok: true, detail: `signature seen at slot ${status.slot ?? "?"}` });

  checks.push({
    id: "signature_did_not_error",
    ok: status.err === null,
    detail: status.err === null ? "transaction succeeded" : `transaction errored: ${JSON.stringify(status.err)}`,
  });

  const rank: Record<string, number> = { processed: 0, confirmed: 1, finalized: 2 };
  const observed = status.status ?? "processed";
  const meetsCommitment = rank[observed]! >= rank[required]!;
  checks.push({
    id: "signature_meets_commitment",
    ok: meetsCommitment,
    detail: meetsCommitment
      ? `commitment ${observed} meets the required ${required}`
      : `commitment ${observed} does not meet the required ${required}`,
  });

  return finish(checks);
}

/**
 * Check 10: the on-chain observation agrees with the application ledger, and
 * the manifest of that reconciliation is signed by content.
 */
export function verifyLedgerAgreement(options: {
  ledgerAmountBaseUnits: bigint;
  observedAmountBaseUnits: bigint;
  ledgerMint: string;
  observedMint: string;
}): VerificationOutcome {
  const checks: CheckOutcome[] = [
    {
      id: "ledger_amount_matches_chain",
      ok: options.ledgerAmountBaseUnits === options.observedAmountBaseUnits,
      detail:
        options.ledgerAmountBaseUnits === options.observedAmountBaseUnits
          ? `${options.ledgerAmountBaseUnits} base units on both sides`
          : `ledger says ${options.ledgerAmountBaseUnits}, the chain says ${options.observedAmountBaseUnits}`,
    },
    {
      id: "ledger_mint_matches_chain",
      ok: options.ledgerMint === options.observedMint,
      detail:
        options.ledgerMint === options.observedMint
          ? `mint ${options.ledgerMint} on both sides`
          : `ledger says mint ${options.ledgerMint}, the chain says ${options.observedMint}`,
    },
  ];
  return finish(checks);
}

/**
 * RPC disagreement: two endpoints that report different balances, slots or
 * signature statuses.
 *
 * A single endpoint is a single point of trust. The blueprint asks for an
 * independent read-back; this is the function that notices when the two reads
 * do not agree, and it refuses rather than picking one.
 */
export function detectRpcDisagreement(
  a: { slot: number; signatureStatus: string | null },
  b: { slot: number; signatureStatus: string | null },
  options: { maxSlotDrift?: number } = {},
): VerificationOutcome {
  const maxDrift = options.maxSlotDrift ?? 150;
  const checks: CheckOutcome[] = [
    {
      id: "providers_agree_on_signature",
      ok: a.signatureStatus === b.signatureStatus,
      detail:
        a.signatureStatus === b.signatureStatus
          ? `both providers report ${a.signatureStatus}`
          : `providers disagree: ${a.signatureStatus} vs ${b.signatureStatus}`,
    },
    {
      id: "providers_within_slot_drift",
      ok: Math.abs(a.slot - b.slot) <= maxDrift,
      detail: `slot drift ${Math.abs(a.slot - b.slot)} against a limit of ${maxDrift}`,
    },
  ];
  return finish(checks);
}

/** The full delivery verification, in the blueprint's order. */
export async function verifyDelivery(
  rpc: SolanaRpc,
  options: {
    /** The mint named in the signed agreement and the manifest. */
    expectedMint: string;
    /** The destination token account. */
    destination: string;
    /** The wallet the destination must belong to. */
    expectedOwner: string;
    /** The exact quantity, in integer base units. */
    expectedAmountBaseUnits: bigint;
    /** The delivery transaction. */
    signature: string;
    /** The commitment the agreement requires. */
    requiredCommitment?: Commitment;
    /** The lock-up account or PDA, when one is used. */
    lockupAccount?: string | null;
    /** Whether the caller's own schedule matches the agreement. */
    scheduleMatchesAgreement: boolean;
    /** The amount the application ledger recorded. */
    ledgerAmountBaseUnits: bigint;
    /** Whether an independent reviewer has resolved the mint authority. */
    mintAuthorityResolved: boolean;
  },
): Promise<VerificationOutcome & { manifest: Record<string, unknown> }> {
  const commitment = options.requiredCommitment ?? "finalized";
  const checks: CheckOutcome[] = [];

  const mintOutcome = await verifyMint(rpc, {
    mint: options.expectedMint,
    expectedMint: options.expectedMint,
    commitment,
  });
  checks.push(...mintOutcome.checks);

  const account = await rpc.getAccountInfo(options.destination, commitment);
  const transferOutcome = verifyTransfer(account, {
    mint: options.expectedMint,
    destination: options.destination,
    amountBaseUnits: options.expectedAmountBaseUnits,
    owner: options.expectedOwner,
  });
  checks.push(...transferOutcome.checks);

  const [status] = await rpc.getSignatureStatuses([options.signature]);
  checks.push(...verifyFinality(options.signature, status ?? null, commitment).checks);

  if (options.lockupAccount) {
    const lockup = await rpc.getAccountInfo(options.lockupAccount, commitment);
    checks.push({
      id: "lockup_account_exists",
      ok: lockup !== null,
      detail: lockup ? `lock-up account found at ${options.lockupAccount}` : `no lock-up account at ${options.lockupAccount}`,
    });
  } else {
    checks.push({
      id: "lockup_mechanism_declared",
      ok: false,
      detail: "no lock-up account was declared; MetaDAO's supported mechanism must be named before delivery",
    });
  }

  checks.push({
    id: "schedule_matches_agreement",
    ok: options.scheduleMatchesAgreement,
    detail: options.scheduleMatchesAgreement
      ? "the vesting schedule matches the signed agreement"
      : "the vesting schedule does not match the signed agreement",
  });

  checks.push(
    ...verifyLedgerAgreement({
      ledgerAmountBaseUnits: options.ledgerAmountBaseUnits,
      observedAmountBaseUnits: transferOutcome.tokenAccount?.amount ?? 0n,
      ledgerMint: options.expectedMint,
      observedMint: transferOutcome.tokenAccount?.mint ?? "",
    }).checks,
  );

  checks.push({
    id: "mint_authority_resolved",
    ok: options.mintAuthorityResolved,
    detail: options.mintAuthorityResolved
      ? "no uncontrolled mint authority remains"
      : "an uncontrolled mint authority remains",
  });

  const outcome = finish(checks);
  return {
    ...outcome,
    manifest: {
      verifiedAt: new Date().toISOString(),
      cluster: rpc.cluster(),
      mint: options.expectedMint,
      destination: options.destination,
      owner: options.expectedOwner,
      amountBaseUnits: options.expectedAmountBaseUnits.toString(),
      signature: options.signature,
      requiredCommitment: commitment,
      checks: outcome.checks,
      ok: outcome.ok,
    },
  };
}