import { hashTypedData, type Address, type Hex } from "viem";

/** EIP-712 schema shared by the publisher and the public API verifier. */
export const SCORECARD_PUBLICATION_TYPES = {
  ScorecardPublication: [
    { name: "cohort", type: "string" },
    { name: "chainId", type: "uint256" },
    { name: "agentId", type: "uint256" },
    { name: "runner", type: "address" },
    { name: "scorecardCid", type: "string" },
    { name: "scorecardDigest", type: "bytes32" },
    { name: "issuedAt", type: "uint64" },
  ],
} as const;

const SCORECARD_REPLAY_TYPES = {
  ScorecardReplay: [
    { name: "cohort", type: "string" },
    { name: "chainId", type: "uint256" },
    { name: "agentId", type: "uint256" },
    { name: "runner", type: "address" },
    { name: "scorecardDigest", type: "bytes32" },
  ],
} as const;

export interface ScorecardPublicationMessage {
  cohort: string;
  chainId: number;
  agentId: number;
  runner: Address;
  scorecardCid: string;
  scorecardDigest: Hex;
  issuedAt: number;
}

export interface ScorecardPublication {
  schemaVersion: 1;
  id: Hex;
  signer: Address;
  message: ScorecardPublicationMessage;
  signature: Hex;
}

export interface ScorecardSubject {
  cohort: string;
  chainId: number;
  agentId: number;
  runner: Address;
  issuedAt: number;
  signer: Address;
}

export function scorecardPublicationDomain(chainId: number) {
  return { name: "Crucible Scorecard", version: "1", chainId } as const;
}

export function scorecardTypedData(message: ScorecardPublicationMessage) {
  return {
    domain: scorecardPublicationDomain(message.chainId),
    types: SCORECARD_PUBLICATION_TYPES,
    primaryType: "ScorecardPublication" as const,
    message: {
      ...message,
      chainId: BigInt(message.chainId),
      agentId: BigInt(message.agentId),
      issuedAt: BigInt(message.issuedAt),
    },
  };
}

/** Stable replay key for one cohort, registered agent and scorecard digest. */
export function scorecardPublicationId(message: ScorecardPublicationMessage): Hex {
  return hashTypedData({
    domain: { name: "Crucible Scorecard Replay", version: "1", chainId: message.chainId },
    types: SCORECARD_REPLAY_TYPES,
    primaryType: "ScorecardReplay",
    message: {
      cohort: message.cohort,
      chainId: BigInt(message.chainId),
      agentId: BigInt(message.agentId),
      runner: message.runner,
      scorecardDigest: message.scorecardDigest,
    },
  });
}

export function isScorecardCohort(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/.test(value);
}
