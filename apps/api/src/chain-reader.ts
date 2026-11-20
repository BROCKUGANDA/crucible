/**
 * @file chain-reader.ts — reading the Arena over RPC.
 *
 * The API holds no chain key (ADR-0006), so everything here is a public
 * read: `eth_call` against a node. A funding verification is a read of the
 * escrow, not a signature over it.
 *
 * The ABI is written out rather than imported from a build artifact because
 * the contracts compile with `forge` and the API compiles with `tsc`; there
 * is no artifact pipeline between them, and a hand-written ABI for three
 * view functions is smaller than a build-step dependency would be. The
 * function names and their return shapes are asserted against the contract
 * by the Foundry suite, so a drift here is caught on the contract side.
 */

import { createPublicClient, http, type Address, type PublicClient } from "viem";
import type { ChainTrialFacts, ChainReader } from "./funding-verification.js";

/**
 * The three Arena views this reader uses.
 *
 * `amountsOf` returns (reward, fee, bond, deposited, paidOut);
 * `partiesOf` returns (sponsor, agent, runner);
 * `stateOf` returns (status, outcome, round, docketFrozen, holdoutRevealed,
 * holdoutMissed).
 */
const ARENA_ABI = [
  {
    type: "function",
    name: "amountsOf",
    stateMutability: "view",
    inputs: [{ name: "id", type: "uint256" }],
    outputs: [
      { name: "reward", type: "uint256" },
      { name: "fee", type: "uint256" },
      { name: "bond", type: "uint256" },
      { name: "deposited", type: "uint256" },
      { name: "paidOut", type: "uint256" },
    ],
  },
  {
    type: "function",
    name: "partiesOf",
    stateMutability: "view",
    inputs: [{ name: "id", type: "uint256" }],
    outputs: [
      { name: "sponsor", type: "address" },
      { name: "agent", type: "address" },
      { name: "runner", type: "address" },
    ],
  },
  {
    type: "function",
    name: "stateOf",
    stateMutability: "view",
    inputs: [{ name: "id", type: "uint256" }],
    outputs: [
      { name: "status", type: "uint8" },
      { name: "outcome", type: "uint8" },
      { name: "round", type: "uint8" },
      { name: "docketFrozen", type: "bool" },
      { name: "holdoutRevealed", type: "bool" },
      { name: "holdoutMissed", type: "bool" },
    ],
  },
  {
    type: "function",
    name: "trialCount",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "uint256" }],
  },
] as const;

export interface ArenaChainReaderOptions {
  rpcUrl: string;
  arenaAddress: string;
  /** A viem chain. Defaults to mainnet; the caller passes the right one. */
  chain?: Parameters<typeof createPublicClient>[0]["chain"];
  /** An existing client, for tests and for the server's shared client. */
  client?: PublicClient;
}

/**
 * Read the Arena's money over RPC.
 *
 * The client is created lazily and cached: `createPublicClient` opens a
 * connection, and a reader that opened one per call would make a
 * reconciliation sweep a connection storm.
 */
export function createArenaChainReader(opts: ArenaChainReaderOptions): ChainReader {
  const arenaAddress = opts.arenaAddress as Address;
  let client = opts.client;
  if (!client) {
    client = createPublicClient({
      chain: opts.chain,
      transport: http(opts.rpcUrl),
    }) as PublicClient;
  }
  const publicClient = client;

  return {
    arenaAddress: opts.arenaAddress,

    async trialCount(): Promise<bigint> {
      const result = await publicClient.readContract({
        address: arenaAddress,
        abi: ARENA_ABI,
        functionName: "trialCount",
      });
      return result as bigint;
    },

    async trialFacts(trialId: bigint): Promise<ChainTrialFacts> {
      const [amounts, parties, state] = await Promise.all([
        publicClient.readContract({
          address: arenaAddress,
          abi: ARENA_ABI,
          functionName: "amountsOf",
          args: [trialId],
        }),
        publicClient.readContract({
          address: arenaAddress,
          abi: ARENA_ABI,
          functionName: "partiesOf",
          args: [trialId],
        }),
        publicClient.readContract({
          address: arenaAddress,
          abi: ARENA_ABI,
          functionName: "stateOf",
          args: [trialId],
        }),
      ]);

      // viem types a multi-return `readContract` as a union of tuples, so the
      // elements come back as possibly-undefined. The ABI above fixes the
      // arity, and an undefined would be a contract that does not match this
      // reader — so the tuple is stated, not guessed.
      const [reward, fee, , deposited, paidOut] = amounts as readonly [
        bigint,
        bigint,
        bigint,
        bigint,
        bigint,
      ];
      const [sponsor] = parties as readonly [string, string, string];
      const [status] = state as readonly [number, number, number, boolean, boolean, boolean];

      return {
        sponsor,
        reward,
        fee,
        deposited,
        paidOut,
        status: Number(status),
      };
    },
  };
}
