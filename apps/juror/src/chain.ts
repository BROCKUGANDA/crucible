import {
  createPublicClient,
  createWalletClient,
  defineChain,
  http,
  type Address,
  type Chain,
  type Hex,
  type PublicClient,
  type WalletClient,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { TRIALS_ABI } from "@crucible/smith";
import { NO_COMMIT, type DisputeView, type SeatConstants } from "./policy.js";

/**
 * The chain, read and written by one seat.
 *
 * Deliberately not built on `Crucible` from `@crucible/smith`: that wrapper is the SDK an
 * *agent* uses, and its config demands an `alloyAddress` because most of its reads are
 * leaderboard ones. A seat never consults the alloy registry, so wiring one up would mean
 * making the operator require a contract address it does not read — a config variable that
 * lies about what the service depends on. Everything below is a direct, named call on the
 * trials ABI, and `TRIALS_ADDRESS` is the only address the seat takes.
 */

type SeatAccount = ReturnType<typeof privateKeyToAccount>;

export interface ChainOptions {
  rpcUrl: string;
  trialsAddress: Address;
  /**
   * The seat's account, already resolved from `SEAT_PRIVATE_KEY` by `config.ts`.
   *
   * Taken as an account rather than a key string so the key is decoded in exactly one place.
   * A second `privateKeyToAccount` call would be a second path a malformed or wrong key could
   * come down, and the refusal that names the variable belongs to the config layer.
   */
  account: SeatAccount;
  /** re-run budget in seconds; it becomes the seat's slack before the commit window closes */
  marginSec: number;
}

/** The writes a seat makes. Both revert on their own guards — the caller collects, never retries blind. */
export interface VotePoster {
  commitVote(trialId: number, commit: Hex): Promise<Hex>;
  revealVote(trialId: number, breakWins: boolean, salt: Hex): Promise<Hex>;
}

/** A `getTrial()` return, narrowed to what a seat asks. */
export interface TrialWord {
  agentId: number;
  runHash: Hex;
  status: number;
}

export class CrucibleChain implements VotePoster {
  readonly address: Address;
  /**
   * A client with no chain configured, used only to ask the node who it is.
   *
   * The EIP-712 domain the artifact was signed under names a chain id, and `LiveVerifier`
   * rebuilds that digest from `RunFacts.chainId`. Hardcoding Anvil's 31337 here would let the
   * seat verify a signature over a domain the runner never used: the recovery would fail on an
   * honest run and pass on nothing. So the number is read, once, from the node the seat is
   * actually pointed at.
   */
  private readonly probe: PublicClient;
  private readonly account: SeatAccount;
  private resolved: Chain | null = null;
  private reader: PublicClient | null = null;
  private signer: WalletClient | null = null;

  constructor(private readonly opts: ChainOptions) {
    this.address = opts.trialsAddress;
    this.account = opts.account;
    this.probe = createPublicClient({ transport: http(opts.rpcUrl) });
  }

  get seat(): Address {
    return this.account.address;
  }

  /** Dial the node and adopt its chain id. Everything else needs the answer. */
  async connect(): Promise<void> {
    const id = await this.probe.getChainId();
    const chain = defineChain({
      id,
      name: `crucible-seat-${id}`,
      nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
      rpcUrls: { default: { http: [this.opts.rpcUrl] } },
    });
    this.resolved = chain;
    this.reader = createPublicClient({ chain, transport: http(this.opts.rpcUrl) });
    this.signer = createWalletClient({ account: this.account, chain, transport: http(this.opts.rpcUrl) });
  }

  private get read(): PublicClient {
    if (!this.reader) throw new Error("CrucibleChain.connect() was never awaited");
    return this.reader;
  }

  private get write(): WalletClient {
    if (!this.signer || !this.resolved) throw new Error("CrucibleChain.connect() was never awaited");
    return this.signer;
  }

  /** The chain id the EIP-712 domain names. */
  get chainId(): number {
    return this.chainConfig.id;
  }

  /**
   * The chain object the node's answer became.
   *
   * `Scribe` takes a `Chain` for its own client, and handing it a literal `foundry` would be a
   * second, independent claim about which network is being indexed — the same claim the seat
   * already made by reading `eth_chainId`. One read, one object, both users.
   */
  get chainConfig(): Chain {
    if (!this.resolved) throw new Error("CrucibleChain.connect() was never awaited");
    return this.resolved;
  }

  /**
   * Is this address one of the seats the constructor granted?
   *
   * Asked at boot, not per trial, because the answer decides whether the process may loop at
   * all: an ungranted seat reverts `NotArgus` on every commit (`CrucibleTrials.sol:555`), so a
   * service that kept trying would be hammering a shared node with transactions that cannot
   * succeed. `isArgus` is the generated getter for
   * `mapping(address => bool) public isArgus` (`:199`), so this is a fact read off the chain
   * rather than an inference from a failed transaction.
   */
  async isArgus(seat: Address = this.seat): Promise<boolean> {
    return this.read.readContract({
      address: this.address,
      abi: TRIALS_ABI,
      functionName: "isArgus",
      args: [seat],
    });
  }

  /** The two dispute rules as this deployment compiled them. */
  async constants(): Promise<SeatConstants> {
    const [windowSec, threshold] = await Promise.all([
      this.read.readContract({ address: this.address, abi: TRIALS_ABI, functionName: "COMMIT_WINDOW" }),
      this.read.readContract({ address: this.address, abi: TRIALS_ABI, functionName: "ARGUS_THRESHOLD" }),
    ]);
    return {
      commitWindowSec: Number(windowSec as bigint),
      threshold: Number(threshold as bigint),
      marginSec: this.opts.marginSec,
    };
  }

  /** The chain's clock, in seconds. Never `Date.now()` — the demo chain is warpable. */
  async chainNow(): Promise<number> {
    const block = await this.read.getBlock();
    return Number(block.timestamp);
  }

  async trial(trialId: number): Promise<TrialWord> {
    const t = await this.read.readContract({
      address: this.address,
      abi: TRIALS_ABI,
      functionName: "getTrial",
      args: [BigInt(trialId)],
    });
    // viem hands a named struct back as an array that also carries the names; the rest of the
    // repo narrows it the same way (`smith-sdk/src/client.ts`'s `getTrial`).
    const word = t as unknown as { agentId: bigint; runHash: Hex; status: number };
    return { agentId: Number(word.agentId), runHash: word.runHash, status: Number(word.status) };
  }

  /**
   * The runner key the *registry* holds for an agent.
   *
   * Read here and never taken from the artifact: the artifact already declares which address
   * signed it, and checking that against itself would produce a green runner-binding gate on a
   * run signed by any key at all.
   */
  async runner(agentId: number): Promise<Address> {
    const agent = await this.read.readContract({
      address: this.address,
      abi: TRIALS_ABI,
      functionName: "getAgent",
      args: [BigInt(agentId)],
    });
    return (agent as unknown as { runner: Address }).runner;
  }

  /**
   * Everything the seat's rules need about one dispute.
   *
   * `openedAt` comes from `disputeOf`, not from the index's `disputeOpenedAt`, because the
   * commit window is measured against the chain's own word while the projection's copy is a
   * hydrated block timestamp — close enough to display, not close enough to sign for. A seat
   * that is wrong about which side of the deadline it is on has already spent the gas.
   */
  async disputeView(
    trialId: number,
    votes: { committed: string[]; revealed: string[] },
  ): Promise<DisputeView> {
    const [trial, dispute, seatVote] = await Promise.all([
      this.trial(trialId),
      this.read.readContract({
        address: this.address,
        abi: TRIALS_ABI,
        functionName: "disputeOf",
        args: [BigInt(trialId)],
      }),
      this.read.readContract({
        address: this.address,
        abi: TRIALS_ABI,
        functionName: "disputeVote",
        args: [BigInt(trialId), this.seat],
      }),
    ]);
    const [openedAt] = dispute as unknown as [bigint, boolean, number, number];
    const [commit, revealed] = seatVote as unknown as [Hex, boolean];
    return {
      trialId,
      status: trial.status,
      openedAt: Number(openedAt),
      committed: votes.committed,
      revealed: votes.revealed,
      // A zero word is what `commitVote` tests for "this seat has never sealed" (`:559`).
      seatCommit: (commit ?? NO_COMMIT) as Hex,
      seatRevealed: Boolean(revealed),
    };
  }

  async commitVote(trialId: number, commit: Hex): Promise<Hex> {
    const chain = this.resolved!;
    return this.write.writeContract({
      address: this.address,
      abi: TRIALS_ABI,
      functionName: "commitVote",
      args: [BigInt(trialId), commit],
      account: this.account,
      chain,
    }) as Promise<Hex>;
  }

  async revealVote(trialId: number, breakWins: boolean, salt: Hex): Promise<Hex> {
    const chain = this.resolved!;
    return this.write.writeContract({
      address: this.address,
      abi: TRIALS_ABI,
      functionName: "revealVote",
      args: [BigInt(trialId), breakWins, salt],
      account: this.account,
      chain,
    }) as Promise<Hex>;
  }
}
