import { describe, expect, it, vi } from "vitest";
import { decodeFunctionData } from "viem";
import { TRIALS_ABI } from "@crucible/smith";
import {
  prepareSafeWithdrawalDraft,
  verifySafeOwner,
  type SafeEip1193Provider,
  type SafeProtocolKitFactory,
  type SafeProtocolKitPort,
  type SafeWithdrawalInput,
} from "../src/lib/safe-withdrawal";
import { OperationType, type MetaTransactionData, type SafeTransaction } from "@safe-global/types-kit";

const OWNER = "0x1111111111111111111111111111111111111111";
const OTHER_OWNER = "0x2222222222222222222222222222222222222222";
const SAFE = "0x3333333333333333333333333333333333333333";
const ESCROW = "0x4444444444444444444444444444444444444444";
const TX_HASH = `0x${"ab".repeat(32)}`;

function makeInput(overrides: Partial<SafeWithdrawalInput> = {}): SafeWithdrawalInput {
  const provider: SafeEip1193Provider = {
    request: vi.fn(async ({ method }: { method: string }) => (method === "eth_chainId" ? "0xaa36a7" : null)),
  };
  return {
    provider,
    connectedAddress: OWNER,
    connectedChainId: 11155111,
    expectedChainId: 11155111,
    treasuryAddress: SAFE,
    escrowAddress: ESCROW,
    creditWei: 2_500_000_000_000_000_000n,
    ...overrides,
  };
}

function makeKit(overrides: {
  deployed?: boolean;
  address?: string;
  chainId?: bigint;
  owners?: string[];
  threshold?: number;
  transactionHash?: string;
  transactionTo?: string;
  transactionValue?: string;
  transactionData?: string;
  transactionOperation?: OperationType;
  transactionNonce?: number;
} = {}) {
  const createTransaction = vi.fn(async ({ transactions }: { transactions: MetaTransactionData[] }) => {
    const requested = transactions[0]!;
    return {
      data: {
        to: overrides.transactionTo ?? requested.to,
        value: overrides.transactionValue ?? requested.value,
        data: overrides.transactionData ?? requested.data,
        operation: overrides.transactionOperation ?? requested.operation ?? OperationType.Call,
        nonce: overrides.transactionNonce ?? 12,
      },
    } as unknown as SafeTransaction;
  });
  const getTransactionHash = vi.fn(async () => overrides.transactionHash ?? TX_HASH);
  const kit: SafeProtocolKitPort = {
    isSafeDeployed: vi.fn(async () => overrides.deployed ?? true),
    getAddress: vi.fn(async () => overrides.address ?? SAFE),
    getChainId: vi.fn(async () => overrides.chainId ?? 11155111n),
    getOwners: vi.fn(async () => overrides.owners ?? [OWNER, OTHER_OWNER]),
    getThreshold: vi.fn(async () => overrides.threshold ?? 2),
    createTransaction,
    getTransactionHash,
  };
  const factory: SafeProtocolKitFactory = vi.fn(async () => kit);
  return { kit, factory, createTransaction, getTransactionHash };
}

describe("Safe Protocol Kit owner verification", () => {
  it("verifies the contract-selected Safe, chain, deployed status, owner and threshold", async () => {
    const { kit, factory } = makeKit();
    const input = makeInput();

    await expect(verifySafeOwner(input, factory)).resolves.toMatchObject({
      ownerAddress: OWNER,
      safeAddress: SAFE,
      escrowAddress: ESCROW,
      chainId: 11155111,
      ownerCount: 2,
      threshold: 2,
    });
    expect(factory).toHaveBeenCalledExactlyOnceWith(input.provider, OWNER, SAFE);
    expect(kit.createTransaction).not.toHaveBeenCalled();
  });

  it("refuses an EOA that is not in the Safe owner list", async () => {
    const { kit, factory } = makeKit({ owners: [OTHER_OWNER] });

    await expect(verifySafeOwner(makeInput(), factory)).rejects.toThrow("not an owner");
    expect(kit.createTransaction).not.toHaveBeenCalled();
  });

  it("fails closed when the provider chain differs from the deployment", async () => {
    const { factory } = makeKit();
    const input = makeInput({
      provider: { request: vi.fn(async () => "0x1") },
    });

    await expect(verifySafeOwner(input, factory)).rejects.toThrow("different chain");
    expect(factory).not.toHaveBeenCalled();
  });

  it("rejects malformed provider chain data and an unconfigured Treasury Safe", async () => {
    const factory = makeKit().factory;
    await expect(
      verifySafeOwner(makeInput({ provider: { request: vi.fn(async () => "not-a-chain-id") } }), factory),
    ).rejects.toThrow("invalid chain id");
    await expect(
      verifySafeOwner(makeInput({ treasuryAddress: "0x0000000000000000000000000000000000000000" }), factory),
    ).rejects.toThrow("Treasury Safe is not configured");
    expect(factory).not.toHaveBeenCalled();
  });

  it("rejects an undeployed or mismatched Safe address", async () => {
    await expect(verifySafeOwner(makeInput(), makeKit({ deployed: false }).factory)).rejects.toThrow("not a deployed Safe");
    await expect(verifySafeOwner(makeInput(), makeKit({ address: OTHER_OWNER }).factory)).rejects.toThrow("different Safe address");
  });

  it("rejects duplicate Safe owners and a Safe on another chain", async () => {
    await expect(verifySafeOwner(makeInput(), makeKit({ owners: [OWNER, OTHER_OWNER, OWNER] }).factory)).rejects.toThrow("duplicate owners");
    await expect(verifySafeOwner(makeInput(), makeKit({ chainId: 1n }).factory)).rejects.toThrow("not on Crucible's configured chain");
  });
});

describe("Safe withdrawal draft", () => {
  it("builds an unsigned Safe transaction to the escrow with only withdraw() calldata", async () => {
    const { kit, factory, createTransaction, getTransactionHash } = makeKit();
    const input = makeInput();
    const draft = await prepareSafeWithdrawalDraft(input, factory);

    expect(draft).toMatchObject({
      ownerAddress: OWNER,
      safeAddress: SAFE,
      escrowAddress: ESCROW,
      targetAddress: ESCROW,
      creditWei: input.creditWei,
      value: "0",
      nonce: 12,
      safeTxHash: TX_HASH,
      threshold: 2,
    });
    expect(decodeFunctionData({ abi: TRIALS_ABI, data: draft.data }).functionName).toBe("withdraw");
    expect(createTransaction).toHaveBeenCalledOnce();
    expect(createTransaction.mock.calls[0]![0].transactions).toEqual([
      { to: ESCROW, value: "0", data: draft.data, operation: OperationType.Call },
    ]);
    expect(getTransactionHash).toHaveBeenCalledOnce();
    expect(Object.keys(kit).sort()).toEqual([
      "createTransaction",
      "getAddress",
      "getChainId",
      "getOwners",
      "getThreshold",
      "getTransactionHash",
      "isSafeDeployed",
    ]);
  });

  it("does not create a draft for unknown or zero credit", async () => {
    const factory = vi.fn(async () => makeKit().kit);

    await expect(prepareSafeWithdrawalDraft(makeInput({ creditWei: undefined }), factory)).rejects.toThrow("unknown");
    await expect(prepareSafeWithdrawalDraft(makeInput({ creditWei: 0n }), factory)).rejects.toThrow("no withdrawable credit");
    expect(factory).not.toHaveBeenCalled();
  });

  it("keeps mainnet drafts disabled until the release evidence gate is satisfied", async () => {
    const input = makeInput({
      connectedChainId: 1,
      expectedChainId: 1,
      provider: { request: vi.fn(async () => "0x1") },
    });
    const factory = vi.fn(async () => makeKit().kit);

    await expect(prepareSafeWithdrawalDraft(input, factory)).rejects.toThrow("ADR-0020 release gates");
    expect(input.provider.request).not.toHaveBeenCalled();
    expect(factory).not.toHaveBeenCalled();
  });

  it("refuses an invalid Safe hash without presenting a draft", async () => {
    const { factory } = makeKit({ transactionHash: "0x1234" });
    await expect(prepareSafeWithdrawalDraft(makeInput(), factory)).rejects.toThrow("invalid transaction hash");
  });

  it.each([
    ["target", { transactionTo: OTHER_OWNER }],
    ["value", { transactionValue: "1" }],
    ["calldata", { transactionData: "0x1234" }],
    ["operation", { transactionOperation: OperationType.DelegateCall }],
  ])("rejects Protocol Kit output that changes the fixed call %s", async (_field, overrides) => {
    const { factory, getTransactionHash } = makeKit(overrides);

    await expect(prepareSafeWithdrawalDraft(makeInput(), factory)).rejects.toThrow("changed the fixed escrow withdraw call");
    expect(getTransactionHash).not.toHaveBeenCalled();
  });

  it("rejects malformed values and nonces returned by Protocol Kit", async () => {
    const invalidValue = makeKit({ transactionValue: "not-an-integer" });
    const invalidNonce = makeKit({ transactionNonce: -1 });

    await expect(prepareSafeWithdrawalDraft(makeInput(), invalidValue.factory)).rejects.toThrow("invalid transaction value");
    await expect(prepareSafeWithdrawalDraft(makeInput(), invalidNonce.factory)).rejects.toThrow("invalid Safe nonce");
    expect(invalidValue.getTransactionHash).not.toHaveBeenCalled();
    expect(invalidNonce.getTransactionHash).not.toHaveBeenCalled();
  });

  it("rejects invalid Safe threshold data", async () => {
    await expect(verifySafeOwner(makeInput(), makeKit({ threshold: 0 }).factory)).rejects.toThrow("invalid owner threshold");
  });
});