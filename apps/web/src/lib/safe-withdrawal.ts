import { OperationType, type MetaTransactionData, type SafeTransaction } from "@safe-global/types-kit";
import { TRIALS_ABI } from "@crucible/smith";
import { encodeFunctionData, getAddress, isAddress, type Address, type Hex } from "viem";

export type SafeEip1193Provider = {
  request(args: { readonly method: string; readonly params?: readonly unknown[] | object }): Promise<unknown>;
};

export interface SafeProtocolKitPort {
  isSafeDeployed(): Promise<boolean>;
  getAddress(): Promise<string>;
  getChainId(): Promise<bigint>;
  getOwners(): Promise<string[]>;
  getThreshold(): Promise<number>;
  createTransaction(input: { transactions: MetaTransactionData[] }): Promise<SafeTransaction>;
  getTransactionHash(transaction: SafeTransaction): Promise<string>;
}

export type SafeProtocolKitFactory = (
  provider: SafeEip1193Provider,
  signer: Address,
  safeAddress: Address,
) => Promise<SafeProtocolKitPort>;

export interface SafeOwnerVerification {
  ownerAddress: Address;
  safeAddress: Address;
  escrowAddress: Address;
  chainId: number;
  ownerCount: number;
  threshold: number;
}

export interface SafeWithdrawalDraft extends SafeOwnerVerification {
  creditWei: bigint;
  targetAddress: Address;
  value: "0";
  data: Hex;
  nonce: number;
  safeTxHash: Hex;
}

export interface SafeOwnerInput {
  provider: SafeEip1193Provider;
  connectedAddress: string;
  connectedChainId: number | undefined;
  expectedChainId: number;
  treasuryAddress: string;
  escrowAddress: string;
}

export interface SafeWithdrawalInput extends SafeOwnerInput {
  creditWei: bigint | null | undefined;
}

export class SafeDraftError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SafeDraftError";
  }
}

async function initProtocolKit(
  provider: SafeEip1193Provider,
  signer: Address,
  safeAddress: Address,
): Promise<SafeProtocolKitPort> {
  const { default: Safe } = await import("@safe-global/protocol-kit");
  return Safe.init({ provider, signer, safeAddress });
}

function checkedAddress(value: string, label: string): Address {
  if (!isAddress(value)) throw new SafeDraftError(`${label} is not a valid EVM address.`);
  let address: Address;
  try {
    address = getAddress(value);
  } catch {
    throw new SafeDraftError(`${label} is not a valid EVM address.`);
  }
  if (address === "0x0000000000000000000000000000000000000000") {
    throw new SafeDraftError(`${label} is not configured.`);
  }
  return address;
}

function checkedChainId(value: unknown): number {
  if (typeof value !== "string" || !/^0x[0-9a-f]+$/i.test(value)) {
    throw new SafeDraftError("The connected wallet returned an invalid chain id.");
  }
  const chainId = Number(BigInt(value));
  if (!Number.isSafeInteger(chainId) || chainId < 1) {
    throw new SafeDraftError("The connected wallet returned an invalid chain id.");
  }
  return chainId;
}

async function verifiedSafe(
  input: SafeOwnerInput,
  factory: SafeProtocolKitFactory,
): Promise<{ kit: SafeProtocolKitPort; verified: SafeOwnerVerification }> {
  if (!Number.isSafeInteger(input.expectedChainId) || input.expectedChainId < 1) {
    throw new SafeDraftError("The Crucible deployment has an invalid chain id.");
  }
  if (input.connectedChainId !== input.expectedChainId) {
    throw new SafeDraftError("Switch the connected owner wallet to Crucible's configured chain first.");
  }

  const ownerAddress = checkedAddress(input.connectedAddress, "Connected owner");
  const safeAddress = checkedAddress(input.treasuryAddress, "Treasury Safe");
  const escrowAddress = checkedAddress(input.escrowAddress, "Escrow contract");
  let providerChainId: number;
  try {
    providerChainId = checkedChainId(await input.provider.request({ method: "eth_chainId" }));
  } catch (error) {
    if (error instanceof SafeDraftError) throw error;
    throw new SafeDraftError("Could not read the connected wallet's chain.");
  }
  if (providerChainId !== input.expectedChainId) {
    throw new SafeDraftError("The wallet provider is on a different chain than the Crucible deployment.");
  }

  let kit: SafeProtocolKitPort;
  let deployed: boolean;
  let actualSafe: string;
  let safeChainId: bigint;
  let owners: string[];
  let threshold: number;
  try {
    kit = await factory(input.provider, ownerAddress, safeAddress);
    [deployed, actualSafe, safeChainId, owners, threshold] = await Promise.all([
      kit.isSafeDeployed(),
      kit.getAddress(),
      kit.getChainId(),
      kit.getOwners(),
      kit.getThreshold(),
    ]);
  } catch {
    throw new SafeDraftError("Could not verify the Treasury Safe through the connected provider.");
  }

  if (!deployed) throw new SafeDraftError("The contract's treasury address is not a deployed Safe.");
  if (!isAddress(actualSafe)) {
    throw new SafeDraftError("The Safe Protocol Kit returned an invalid Safe address.");
  }
  let normalizedSafe: Address;
  try {
    normalizedSafe = getAddress(actualSafe);
  } catch {
    throw new SafeDraftError("The Safe Protocol Kit returned an invalid Safe address.");
  }
  if (normalizedSafe !== safeAddress) {
    throw new SafeDraftError("The Safe Protocol Kit returned a different Safe address than the contract.");
  }
  if (safeChainId !== BigInt(input.expectedChainId)) {
    throw new SafeDraftError("The Treasury Safe is not on Crucible's configured chain.");
  }

  const normalizedOwners = owners.map((owner) => checkedAddress(owner, "Safe owner"));
  if (new Set(normalizedOwners.map((owner) => owner.toLowerCase())).size !== normalizedOwners.length) {
    throw new SafeDraftError("The Treasury Safe returned duplicate owners.");
  }
  if (!normalizedOwners.some((owner) => owner === ownerAddress)) {
    throw new SafeDraftError("The connected account is not an owner of the Treasury Safe.");
  }
  if (!Number.isSafeInteger(threshold) || threshold < 1 || threshold > normalizedOwners.length) {
    throw new SafeDraftError("The Treasury Safe returned an invalid owner threshold.");
  }

  return {
    kit,
    verified: {
      ownerAddress,
      safeAddress,
      escrowAddress,
      chainId: input.expectedChainId,
      ownerCount: normalizedOwners.length,
      threshold,
    },
  };
}

export async function verifySafeOwner(
  input: SafeOwnerInput,
  factory: SafeProtocolKitFactory = initProtocolKit,
): Promise<SafeOwnerVerification> {
  return (await verifiedSafe(input, factory)).verified;
}

export async function prepareSafeWithdrawalDraft(
  input: SafeWithdrawalInput,
  factory: SafeProtocolKitFactory = initProtocolKit,
): Promise<SafeWithdrawalDraft> {
  if (input.expectedChainId === 1) {
    throw new SafeDraftError("Mainnet Safe drafts are disabled until the ADR-0020 release gates are approved and verified.");
  }
  if (input.creditWei === null || input.creditWei === undefined) {
    throw new SafeDraftError("The Treasury Safe's on-chain credit is unknown; no draft was created.");
  }
  if (input.creditWei <= 0n) {
    throw new SafeDraftError("The Treasury Safe has no withdrawable credit; no draft was created.");
  }

  const { kit, verified } = await verifiedSafe(input, factory);
  const data = encodeFunctionData({ abi: TRIALS_ABI, functionName: "withdraw" });
  let transaction: SafeTransaction;
  let hash: string;
  try {
    transaction = await kit.createTransaction({
      transactions: [
        {
          to: verified.escrowAddress,
          value: "0",
          data,
          operation: OperationType.Call,
        },
      ],
    });
  } catch {
    throw new SafeDraftError("Safe Protocol Kit could not build the transaction draft.");
  }
  const transactionData = transaction.data;
  const transactionTarget = checkedAddress(transactionData.to, "Safe transaction target");
  let transactionValue: bigint;
  try {
    transactionValue = BigInt(transactionData.value);
  } catch {
    throw new SafeDraftError("Safe Protocol Kit returned an invalid transaction value.");
  }
  if (
    transactionTarget !== verified.escrowAddress ||
    transactionData.data.toLowerCase() !== data.toLowerCase() ||
    transactionValue !== 0n ||
    transactionData.operation !== OperationType.Call
  ) {
    throw new SafeDraftError("Safe Protocol Kit changed the fixed escrow withdraw call.");
  }
  if (!Number.isSafeInteger(transactionData.nonce) || transactionData.nonce < 0) {
    throw new SafeDraftError("Safe Protocol Kit returned an invalid Safe nonce.");
  }
  try {
    hash = await kit.getTransactionHash(transaction);
  } catch {
    throw new SafeDraftError("Safe Protocol Kit could not hash the transaction draft.");
  }
  if (!/^0x[0-9a-f]{64}$/i.test(hash)) {
    throw new SafeDraftError("Safe Protocol Kit returned an invalid transaction hash.");
  }

  return {
    ...verified,
    creditWei: input.creditWei,
    targetAddress: verified.escrowAddress,
    value: "0",
    data,
    nonce: transactionData.nonce,
    safeTxHash: hash as Hex,
  };
}