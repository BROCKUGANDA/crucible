import {
  concatHex,
  createPublicClient,
  createWalletClient,
  http,
  keccak256,
  parseAbiItem,
  toHex,
  type Address,
  type Chain,
  type Hex,
  type PublicClient,
  type WalletClient,
} from "viem";
import { ALLOY_ABI, TRIALS_ABI } from "./abi.js";
import {
  RUN_PRIMARY_TYPE,
  RUN_TYPES,
  computeRunHash,
  domainFor,
  runMessage,
} from "./eip712.js";
import {
  validateAgainstTrial,
  type RunArtifact,
  type TrialContext,
} from "./types.js";

export interface CrucibleConfig {
  trialsAddress: Address;
  alloyAddress: Address;
  chain: Chain;
  rpcUrl: string;
  /** trialId -> CID text, from the indexer. Optional; see trialContext. */
  cidIndex?: CidIndex;
}

/**
 * Maps a trial to the CID *text* that addresses its pinned spec and suite.
 *
 * The contract commits to bytes32 digests, which are one-way — you cannot derive
 * "bafybei…" from the digest. Anything that needs to actually fetch from an IPFS
 * gateway (Argus re-running the suite) must resolve the text through this.
 */
export interface CidIndex {
  spec(trialId: bigint): string;
  tests(trialId: bigint): string;
}

export interface TrialStruct {
  sponsor: Address;
  specCID: Hex;
  testsCID: Hex;
  reward: bigint;
  bond: bigint;
  /** createdAt | deadline<<64 | breakWindow<<128 | runAt<<192 */
  timestamps: bigint;
  agentId: bigint;
  runHash: Hex;
  breakProofCID: Hex;
  breakSkeptic: Address;
  breakStake: bigint;
  status: number;
  verdict: number;
}

export interface AgentStruct {
  operator: Address;
  runner: Address;
  metadataURI: string;
  stake: bigint;
  active: number;
}

export interface DecodedTrial extends TrialStruct {
  createdAt: number;
  deadline: number;
  breakWindow: number;
  runAt: number;
}

const UINT64_MASK = (1n << 64n) - 1n;

/**
 * Read the n-th uint64 out of the packed timestamps word.
 * Order matches CrucibleTrials.Trial: 0 createdAt, 1 deadline, 2 breakWindow, 3 runAt.
 */
export function unpackTimestamp(word: bigint, index: 0 | 1 | 2 | 3): number {
  return Number((word >> BigInt(64 * index)) & UINT64_MASK);
}

/**
 * Thin, typed wrapper over CrucibleTrials. Every method that submits a claim
 * validates the artifact first, so a red run never reaches the chain.
 */
export class Crucible {
  readonly publicClient: PublicClient;
  readonly config: CrucibleConfig;

  readonly cidIndex?: CidIndex;

  constructor(config: CrucibleConfig) {
    this.config = config;
    this.publicClient = createPublicClient({
      chain: config.chain,
      transport: http(config.rpcUrl),
    }) as PublicClient;
    this.cidIndex = config.cidIndex;
  }

  get address(): Address {
    return this.config.trialsAddress;
  }

  walletClient(account: Address): WalletClient {
    return createWalletClient({
      account,
      chain: this.config.chain,
      transport: http(this.config.rpcUrl),
    }) as WalletClient;
  }

  // ── reads ──────────────────────────────────────────────────────────────
  /** Raw on-chain trial, including the packed `timestamps` word. */
  async getTrial(id: bigint): Promise<TrialStruct> {
    const r = await this.publicClient.readContract({
      address: this.address,
      abi: TRIALS_ABI,
      functionName: "getTrial",
      args: [id],
    });
    return r as TrialStruct;
  }

  async getAgent(id: bigint): Promise<AgentStruct> {
    const r = await this.publicClient.readContract({
      address: this.address,
      abi: TRIALS_ABI,
      functionName: "getAgent",
      args: [id],
    });
    return r as AgentStruct;
  }

  /** Trial with the packed timestamps word unpacked into named fields. */
  async getTrialView(id: bigint): Promise<DecodedTrial> {
    const t = await this.getTrial(id);
    return {
      ...t,
      createdAt: unpackTimestamp(t.timestamps, 0),
      deadline: unpackTimestamp(t.timestamps, 1),
      breakWindow: unpackTimestamp(t.timestamps, 2),
      runAt: unpackTimestamp(t.timestamps, 3),
    };
  }

  async bondFor(reward: bigint): Promise<bigint> {
    return this.publicClient.readContract({
      address: this.address,
      abi: TRIALS_ABI,
      functionName: "bondFor",
      args: [reward],
    });
  }

  async agentIdOf(operator: Address): Promise<bigint> {
    return this.publicClient.readContract({
      address: this.address,
      abi: TRIALS_ABI,
      functionName: "agentIdOf",
      args: [operator],
    });
  }

  async credit(who: Address): Promise<bigint> {
    return this.publicClient.readContract({
      address: this.address,
      abi: TRIALS_ABI,
      functionName: "credit",
      args: [who],
    });
  }

  /** 0 Unforged · 1 Iron · 2 Bronze · 3 Steel · 4 Damascus */
  async alloyTier(agentId: bigint): Promise<number> {
    return this.publicClient.readContract({
      address: this.config.alloyAddress,
      abi: ALLOY_ABI,
      functionName: "tierOf",
      args: [agentId],
    });
  }

  async alloyTierName(agentId: bigint): Promise<string> {
    return this.publicClient.readContract({
      address: this.config.alloyAddress,
      abi: ALLOY_ABI,
      functionName: "tierName",
      args: [agentId],
    });
  }

  /** ERC-5192. True once minted; a minted Alloy can never move. */
  async alloyLocked(agentId: bigint): Promise<boolean> {
    return this.publicClient.readContract({
      address: this.config.alloyAddress,
      abi: ALLOY_ABI,
      functionName: "locked",
      args: [agentId],
    });
  }

  async alloyRecord(agentId: bigint): Promise<{
    wins: number;
    survived: number;
    slashes: number;
    tier: number;
  }> {
    const [wins, survived, slashes, tier] = await this.publicClient.readContract({
      address: this.config.alloyAddress,
      abi: ALLOY_ABI,
      functionName: "records",
      args: [agentId],
    });
    return { wins, survived, slashes, tier };
  }

  async alloyTokenUri(agentId: bigint): Promise<string> {
    return this.publicClient.readContract({
      address: this.config.alloyAddress,
      abi: ALLOY_ABI,
      functionName: "tokenURI",
      args: [agentId],
    });
  }

  /**
   * Assemble the TrialContext that local validation needs. Reads createdAt,
   * deadline, specCID, testsCID and the assigned agent's runner key.
   */
  async trialContext(trialId: bigint, cidIndex?: CidIndex): Promise<TrialContext> {
    const t = await this.getTrialView(trialId);
    if (t.agentId === 0n) {
      throw new Error(`trial ${trialId} has no assigned agent yet`);
    }
    const agent = await this.getAgent(t.agentId);

    const specDigest = t.specCID;
    const testsDigest = t.testsCID;
    // The bytes32 on-chain is the commitment; the CID text that addresses the
    // content is only recoverable from the indexer. Compare digests, so the SDK
    // stays correct even with no indexer configured.
    const specCID = cidIndex?.spec(trialId) ?? specDigest;
    const testsCID = cidIndex?.tests(trialId) ?? testsDigest;

    return {
      trialId: Number(trialId),
      agentId: Number(t.agentId),
      specCID,
      testsCID,
      specDigest,
      testsDigest,
      createdAtMs: t.createdAt * 1000,
      deadlineMs: t.deadline * 1000,
      runnerAddress: agent.runner,
      chainId: this.config.chain.id,
      verifyingContract: this.address,
    };
  }

  // ── writes ─────────────────────────────────────────────────────────────
  async registerAgent(
    wallet: WalletClient,
    metadataURI: string,
    runner: Address,
    value: bigint,
  ): Promise<Hex> {
    const hash = await wallet.writeContract({
      address: this.address,
      abi: TRIALS_ABI,
      functionName: "registerAgent",
      args: [metadataURI, runner],
      value,
      chain: this.config.chain,
      account: wallet.account!,
    });
    return hash;
  }

  async claimTrial(wallet: WalletClient, trialId: bigint): Promise<Hex> {
    return wallet.writeContract({
      address: this.address,
      abi: TRIALS_ABI,
      functionName: "claimTrial",
      args: [trialId],
      chain: this.config.chain,
      account: wallet.account!,
    });
  }

  /**
   * Sign the artifact with the *runner* key and submit. The signature authorises
   * the write; anyone may relay the transaction.
   *
   * The runner key is deliberately not the operator key: an operator compromise
   * then cannot forge a claim for work it never did.
   */
  async submitRun(args: {
    runner: WalletClient;
    operator?: Address;
    artifact: RunArtifact;
    agentId: bigint;
    sigDeadline?: bigint;
    skipOnChainContext?: boolean;
  }): Promise<{ runHash: Hex; txHash: Hex }> {
    const runHash = computeRunHash(args.artifact);

    if (!args.skipOnChainContext) {
      const ctx = await this.trialContext(BigInt(args.artifact.trialId));
      if (BigInt(ctx.agentId) !== args.agentId) {
        throw new Error(
          `trial ${args.artifact.trialId} is assigned to agent ${ctx.agentId}, not ${args.agentId}`,
        );
      }
      validateAgainstTrial(args.artifact, ctx);
    } else {
      const { validateArtifact } = await import("./types.js");
      validateArtifact(args.artifact);
    }

    const sigDeadline =
      args.sigDeadline ?? BigInt(Math.floor(Date.now() / 1000) + 600);

    const signature = (await args.runner.signTypedData({
      domain: domainFor(this.address, this.config.chain.id),
      types: RUN_TYPES,
      primaryType: RUN_PRIMARY_TYPE,
      message: runMessage({
        trialId: args.artifact.trialId,
        agentId: args.agentId,
        runHash,
        sigDeadline,
      }),
      account: args.runner.account!,
    })) as Hex;

    // permissionless: the contract checks the signature, not msg.sender
    const relayer =
      args.operator && args.operator !== args.runner.account!.address
        ? args.operator
        : args.runner.account!.address;
    const txHash = await args.runner.writeContract({
      address: this.address,
      abi: TRIALS_ABI,
      functionName: "submitRun",
      args: [BigInt(args.artifact.trialId), runHash, signature, sigDeadline],
      chain: this.config.chain,
      account: args.runner.account!,
    });
    void relayer;
    return { runHash, txHash };
  }

  async fileBreak(wallet: WalletClient, trialId: bigint, proofCID: Hex, value: bigint): Promise<Hex> {
    return wallet.writeContract({
      address: this.address,
      abi: TRIALS_ABI,
      functionName: "fileBreak",
      args: [trialId, proofCID],
      value,
      chain: this.config.chain,
      account: wallet.account!,
    });
  }

  async finalize(wallet: WalletClient, trialId: bigint): Promise<Hex> {
    return wallet.writeContract({
      address: this.address,
      abi: TRIALS_ABI,
      functionName: "finalize",
      args: [trialId],
      chain: this.config.chain,
      account: wallet.account!,
    });
  }

  async withdraw(wallet: WalletClient): Promise<Hex> {
    return wallet.writeContract({
      address: this.address,
      abi: TRIALS_ABI,
      functionName: "withdraw",
      args: [],
      chain: this.config.chain,
      account: wallet.account!,
    });
  }

  // ── Argus ──────────────────────────────────────────────────────────────
  /**
   * The sealed commitment: keccak256(abi.encodePacked(uint256 trialId, bool
   * breakWins, bytes32 salt)).
   *
   * abi.encodePacked on a uint256 is the 32-byte big-endian word (NOT its decimal
   * text), and a bool is a single 0x00/0x01 byte. Getting this wrong produces a
   * commitment that never matches on reveal, so it is built from bytes explicitly
   * rather than string interpolation.
   */
  static commit(trialId: bigint, breakWins: boolean, salt: Hex): Hex {
    const trialWord = toHex(trialId, { size: 32 });
    const boolByte = breakWins ? "0x01" : "0x00";
    return keccak256(concatHex([trialWord, boolByte as Hex, salt]));
  }

  async commitVote(wallet: WalletClient, trialId: bigint, commit: Hex): Promise<Hex> {
    return wallet.writeContract({
      address: this.address,
      abi: TRIALS_ABI,
      functionName: "commitVote",
      args: [trialId, commit],
      chain: this.config.chain,
      account: wallet.account!,
    });
  }

  async revealVote(
    wallet: WalletClient,
    trialId: bigint,
    breakWins: boolean,
    salt: Hex,
  ): Promise<Hex> {
    return wallet.writeContract({
      address: this.address,
      abi: TRIALS_ABI,
      functionName: "revealVote",
      args: [trialId, breakWins, salt],
      chain: this.config.chain,
      account: wallet.account!,
    });
  }
}

/**
 * The contract stores CIDs as opaque bytes32. It is NOT a recoverable encoding of
 * the CID text: the spec commits to a digest, and a digest cannot be reversed into
 * the CID string that addresses the same content.
 *
 * So `bytes32ToCid` is intentionally lossy and only useful for display. The indexer
 * keeps the authoritative trialId -> CID mapping from the sponsor's own submission
 * off-chain, and looks that up by trialId — never by trying to decode bytes32.
 */
export function bytes32ToCid(hex: Hex): string {
  return hex;
}

export const MIN_REWARD_SELECTOR = parseAbiItem("function MIN_BOND() view returns (uint256)");
