import { describe, expect, it } from "vitest";
import { base58Encode } from "../src/base58.js";
import type { Commitment, SignatureStatus, SolanaAccountInfo, SolanaRpc } from "../src/rpc.js";
import {
  TOKEN_PROGRAMS,
  detectRpcDisagreement,
  verifyDelivery,
  verifyFinality,
  verifyLedgerAgreement,
  verifyMint,
  verifyTransfer,
} from "../src/verification.js";

function key(fill: number): { raw: Uint8Array; base58: string } {
  const raw = new Uint8Array(32).fill(fill);
  return { raw, base58: base58Encode(raw) };
}

function writeU32(bytes: Uint8Array, offset: number, value: number): void {
  new DataView(bytes.buffer, bytes.byteOffset, bytes.length).setUint32(offset, value, true);
}
function writeU64(bytes: Uint8Array, offset: number, value: bigint): void {
  new DataView(bytes.buffer, bytes.byteOffset, bytes.length).setBigUint64(offset, value, true);
}

function mintAccount(options: {
  mintAuthority: Uint8Array | null;
  supply: bigint;
  decimals?: number;
  owner?: string;
}): SolanaAccountInfo {
  const bytes = new Uint8Array(82);
  writeU32(bytes, 0, options.mintAuthority ? 1 : 0);
  if (options.mintAuthority) bytes.set(options.mintAuthority, 4);
  writeU64(bytes, 36, options.supply);
  bytes[44] = options.decimals ?? 6;
  bytes[45] = 1;
  return {
    dataBase64: Buffer.from(bytes).toString("base64"),
    owner: options.owner ?? TOKEN_PROGRAMS.SPL_TOKEN,
    lamports: 1_461_600,
    executable: false,
    slot: 100,
  };
}

function tokenAccountData(options: {
  mint: Uint8Array;
  owner: Uint8Array;
  amount: bigint;
  state?: number;
  ownerProgram?: string;
}): SolanaAccountInfo {
  const bytes = new Uint8Array(165);
  bytes.set(options.mint, 0);
  bytes.set(options.owner, 32);
  writeU64(bytes, 64, options.amount);
  bytes[108] = options.state ?? 1;
  return {
    dataBase64: Buffer.from(bytes).toString("base64"),
    owner: options.ownerProgram ?? TOKEN_PROGRAMS.SPL_TOKEN,
    lamports: 2_039_280,
    executable: false,
    slot: 100,
  };
}

/** A scripted RPC. Every read is a lookup, so a test states the chain it wants. */
class FakeRpc implements SolanaRpc {
  accounts = new Map<string, SolanaAccountInfo>();
  statuses = new Map<string, SignatureStatus>();

  cluster(): string {
    return "devnet";
  }
  async getGenesisHash(): Promise<string> {
    return "genesis";
  }
  async getSlot(_commitment: Commitment): Promise<number> {
    return 100;
  }
  async getAccountInfo(address: string): Promise<SolanaAccountInfo | null> {
    return this.accounts.get(address) ?? null;
  }
  async getSignatureStatuses(signatures: readonly string[]): Promise<(SignatureStatus | null)[]> {
    return signatures.map((s) => this.statuses.get(s) ?? null);
  }
  async getTokenSupply(): Promise<{ amount: string; decimals: number }> {
    return { amount: "0", decimals: 6 };
  }
}

const MINT = key(0xaa);
const DESTINATION = key(0xbb);
const OWNER = key(0xcc);
const SIGNATURE = "signature-1";

function happyChain(): FakeRpc {
  const rpc = new FakeRpc();
  rpc.accounts.set(MINT.base58, mintAccount({ mintAuthority: null, supply: 1_000_000n }));
  rpc.accounts.set(
    DESTINATION.base58,
    tokenAccountData({ mint: MINT.raw, owner: OWNER.raw, amount: 25_000n }),
  );
  rpc.statuses.set(SIGNATURE, { status: "finalized", err: null, slot: 99, confirmations: null });
  return rpc;
}

describe("verifyMint", () => {
  it("passes a canonical, fully-minted, authority-revoked mint", async () => {
    const rpc = happyChain();
    const outcome = await verifyMint(rpc, {
      mint: MINT.base58,
      expectedMint: MINT.base58,
      expectedSupply: 1_000_000n,
      expectedMintAuthority: null,
    });
    expect(outcome.ok).toBe(true);
    expect(outcome.mint?.supply).toBe(1_000_000n);
  });

  it("refuses a mint whose address is not the configured one", async () => {
    const rpc = happyChain();
    const outcome = await verifyMint(rpc, {
      mint: key(0x01).base58,
      expectedMint: MINT.base58,
    });
    expect(outcome.ok).toBe(false);
    expect(outcome.reasons.join(" ")).toMatch(/not the configured mint/);
  });

  it("refuses a mint that does not exist", async () => {
    const rpc = new FakeRpc();
    const outcome = await verifyMint(rpc, { mint: MINT.base58, expectedMint: MINT.base58 });
    expect(outcome.ok).toBe(false);
    expect(outcome.checks.find((c) => c.id === "mint_account_exists")?.ok).toBe(false);
  });

  it("refuses a supply that no longer matches the legal snapshot", async () => {
    const rpc = happyChain();
    const outcome = await verifyMint(rpc, {
      mint: MINT.base58,
      expectedMint: MINT.base58,
      expectedSupply: 2_000_000n,
    });
    expect(outcome.ok).toBe(false);
    expect(outcome.checks.find((c) => c.id === "supply_matches_snapshot")?.ok).toBe(false);
  });

  it("refuses an account owned by something other than a token program", async () => {
    const rpc = new FakeRpc();
    rpc.accounts.set(
      MINT.base58,
      mintAccount({ mintAuthority: null, supply: 1n, owner: "SomeOtherProgram1111111111111111111111111" }),
    );
    const outcome = await verifyMint(rpc, { mint: MINT.base58, expectedMint: MINT.base58 });
    expect(outcome.ok).toBe(false);
    expect(outcome.checks.find((c) => c.id === "mint_owned_by_token_program")?.ok).toBe(false);
  });

  it("refuses a mint whose authority is still live when it should be revoked", async () => {
    const rpc = new FakeRpc();
    rpc.accounts.set(
      MINT.base58,
      mintAccount({ mintAuthority: key(0x11).raw, supply: 1_000_000n }),
    );
    const outcome = await verifyMint(rpc, {
      mint: MINT.base58,
      expectedMint: MINT.base58,
      expectedMintAuthority: null,
    });
    expect(outcome.ok).toBe(false);
    expect(outcome.checks.find((c) => c.id === "mint_authority_matches")?.ok).toBe(false);
  });
});

describe("verifyTransfer", () => {
  const expected = {
    mint: MINT.base58,
    destination: DESTINATION.base58,
    amountBaseUnits: 25_000n,
    owner: OWNER.base58,
  };

  it("passes a destination holding exactly the delivered amount", () => {
    const account = tokenAccountData({ mint: MINT.raw, owner: OWNER.raw, amount: 25_000n });
    expect(verifyTransfer(account, expected).ok).toBe(true);
  });

  it("refuses a missing destination", () => {
    expect(verifyTransfer(null, expected).ok).toBe(false);
  });

  it("refuses the wrong mint", () => {
    const account = tokenAccountData({ mint: key(0x01).raw, owner: OWNER.raw, amount: 25_000n });
    const outcome = verifyTransfer(account, expected);
    expect(outcome.ok).toBe(false);
    expect(outcome.checks.find((c) => c.id === "destination_mint_matches")?.ok).toBe(false);
  });

  it("refuses the wrong owner", () => {
    const account = tokenAccountData({ mint: MINT.raw, owner: key(0x02).raw, amount: 25_000n });
    const outcome = verifyTransfer(account, expected);
    expect(outcome.ok).toBe(false);
    expect(outcome.checks.find((c) => c.id === "destination_owner_matches")?.ok).toBe(false);
  });

  it("refuses a balance that is off by one base unit", () => {
    const account = tokenAccountData({ mint: MINT.raw, owner: OWNER.raw, amount: 24_999n });
    const outcome = verifyTransfer(account, expected);
    expect(outcome.ok).toBe(false);
    expect(outcome.checks.find((c) => c.id === "quantity_matches_exactly")?.ok).toBe(false);
  });

  it("refuses a frozen destination", () => {
    const account = tokenAccountData({ mint: MINT.raw, owner: OWNER.raw, amount: 25_000n, state: 2 });
    const outcome = verifyTransfer(account, expected);
    expect(outcome.ok).toBe(false);
    expect(outcome.checks.find((c) => c.id === "destination_not_frozen")?.ok).toBe(false);
  });

  it("refuses a destination that does not decode as a token account", () => {
    const outcome = verifyTransfer(
      { dataBase64: Buffer.from(new Uint8Array(10)).toString("base64"), owner: TOKEN_PROGRAMS.SPL_TOKEN },
      expected,
    );
    expect(outcome.ok).toBe(false);
    expect(outcome.checks.find((c) => c.id === "destination_is_token_account")?.ok).toBe(false);
  });
});

describe("verifyFinality", () => {
  it("passes a finalized, error-free transaction", () => {
    const outcome = verifyFinality(SIGNATURE, {
      status: "finalized",
      err: null,
      slot: 1,
      confirmations: null,
    });
    expect(outcome.ok).toBe(true);
  });

  it("refuses an unknown signature", () => {
    expect(verifyFinality(SIGNATURE, null).ok).toBe(false);
  });

  it("refuses a confirmed-but-not-finalized transaction", () => {
    const outcome = verifyFinality(SIGNATURE, {
      status: "confirmed",
      err: null,
      slot: 1,
      confirmations: 10,
    });
    expect(outcome.ok).toBe(false);
    expect(outcome.checks.find((c) => c.id === "signature_meets_commitment")?.ok).toBe(false);
  });

  it("refuses a transaction that errored", () => {
    const outcome = verifyFinality(SIGNATURE, {
      status: "finalized",
      err: { InstructionError: [0, "Custom"] },
      slot: 1,
      confirmations: null,
    });
    expect(outcome.ok).toBe(false);
    expect(outcome.checks.find((c) => c.id === "signature_did_not_error")?.ok).toBe(false);
  });
});

describe("ledger agreement", () => {
  it("passes when the two sides agree", () => {
    expect(
      verifyLedgerAgreement({
        ledgerAmountBaseUnits: 10n,
        observedAmountBaseUnits: 10n,
        ledgerMint: "a",
        observedMint: "a",
      }).ok,
    ).toBe(true);
  });

  it("refuses a one-base-unit disagreement", () => {
    const outcome = verifyLedgerAgreement({
      ledgerAmountBaseUnits: 10n,
      observedAmountBaseUnits: 11n,
      ledgerMint: "a",
      observedMint: "a",
    });
    expect(outcome.ok).toBe(false);
    expect(outcome.reasons[0]).toMatch(/ledger says 10/);
  });
});

describe("RPC disagreement", () => {
  it("passes two providers that agree", () => {
    expect(
      detectRpcDisagreement({ slot: 100, signatureStatus: "finalized" }, { slot: 110, signatureStatus: "finalized" }).ok,
    ).toBe(true);
  });

  it("refuses providers that disagree on status", () => {
    const outcome = detectRpcDisagreement(
      { slot: 100, signatureStatus: "finalized" },
      { slot: 100, signatureStatus: "confirmed" },
    );
    expect(outcome.ok).toBe(false);
  });

  it("refuses providers whose slots have drifted too far", () => {
    const outcome = detectRpcDisagreement(
      { slot: 100, signatureStatus: "finalized" },
      { slot: 400, signatureStatus: "finalized" },
      { maxSlotDrift: 150 },
    );
    expect(outcome.ok).toBe(false);
  });
});

describe("verifyDelivery", () => {
  const base = {
    expectedMint: MINT.base58,
    destination: DESTINATION.base58,
    expectedOwner: OWNER.base58,
    expectedAmountBaseUnits: 25_000n,
    signature: SIGNATURE,
    lockupAccount: key(0xdd).base58,
    scheduleMatchesAgreement: true,
    ledgerAmountBaseUnits: 25_000n,
    mintAuthorityResolved: true,
  };

  it("passes a fully verified delivery and emits a manifest", async () => {
    const rpc = happyChain();
    rpc.accounts.set(key(0xdd).base58, {
      dataBase64: Buffer.from(new Uint8Array(82)).toString("base64"),
      owner: TOKEN_PROGRAMS.SPL_TOKEN,
      lamports: 1,
      executable: false,
    });
    const outcome = await verifyDelivery(rpc, base);
    expect(outcome.ok).toBe(true);
    expect(outcome.manifest.cluster).toBe("devnet");
    expect(outcome.manifest.ok).toBe(true);
  });

  it("refuses when no lock-up mechanism was declared", async () => {
    const rpc = happyChain();
    const outcome = await verifyDelivery(rpc, { ...base, lockupAccount: null });
    expect(outcome.ok).toBe(false);
    expect(outcome.checks.find((c) => c.id === "lockup_mechanism_declared")?.ok).toBe(false);
  });

  it("refuses when the schedule does not match the agreement", async () => {
    const rpc = happyChain();
    rpc.accounts.set(key(0xdd).base58, {
      dataBase64: Buffer.from(new Uint8Array(82)).toString("base64"),
      owner: TOKEN_PROGRAMS.SPL_TOKEN,
      lamports: 1,
      executable: false,
    });
    const outcome = await verifyDelivery(rpc, { ...base, scheduleMatchesAgreement: false });
    expect(outcome.ok).toBe(false);
  });

  it("refuses when the ledger disagrees with the chain", async () => {
    const rpc = happyChain();
    rpc.accounts.set(key(0xdd).base58, {
      dataBase64: Buffer.from(new Uint8Array(82)).toString("base64"),
      owner: TOKEN_PROGRAMS.SPL_TOKEN,
      lamports: 1,
      executable: false,
    });
    const outcome = await verifyDelivery(rpc, { ...base, ledgerAmountBaseUnits: 20_000n });
    expect(outcome.ok).toBe(false);
    expect(outcome.checks.find((c) => c.id === "ledger_amount_matches_chain")?.ok).toBe(false);
  });

  it("refuses an unreconciled mint authority", async () => {
    const rpc = happyChain();
    rpc.accounts.set(key(0xdd).base58, {
      dataBase64: Buffer.from(new Uint8Array(82)).toString("base64"),
      owner: TOKEN_PROGRAMS.SPL_TOKEN,
      lamports: 1,
      executable: false,
    });
    const outcome = await verifyDelivery(rpc, { ...base, mintAuthorityResolved: false });
    expect(outcome.ok).toBe(false);
  });
});