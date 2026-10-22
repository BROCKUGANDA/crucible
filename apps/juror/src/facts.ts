import type { Address, Hex } from "viem";
import type { RunFacts } from "@crucible/argus";
import type { ContentService } from "@crucible/forge-runner";

/**
 * What the seat can read off the chain about a run, and the one thing it cannot.
 *
 * `RunFacts` is the input the deterministic verifier needs; this file is the only place that
 * assembles it from a live chain, so the provenance of every field is stated once:
 *
 *   trialId             — the caller's
 *   agentId, runHash    — `Trial` (`getTrial`), the words `submitRun` recorded
 *   runner              — `Agent.runner` from the registry, NEVER the artifact's own claim
 *   chainId             — `eth_chainId` from the node this seat is dialled into
 *   verifyingContract   — `TRIALS_ADDRESS`
 *
 * GAP(`packages/argus/src/live.ts`): `sigDeadline` is still on `RunFacts`, and the chain does
 * not store it. `struct Trial` (`CrucibleTrials.sol:94`) packs four timestamps and a run hash
 * and keeps no signature deadline — `submitRun` checks the deadline and forgets it. The only
 * surviving record is the disclosure entry `ContentBridge.pinArtifact` wrote when the runner
 * published the bytes, which is the same record `LiveVerifier.verify` already reads.
 *
 * It matters here because the verifier does not merely carry the field: `digestFor(facts)`
 * hashes it into the EIP-712 message, and the recovery inside `verify()` uses the record's own
 * copy. Two sources for one number means the digest and the recovered signer can be computed
 * over different messages, and the disagreement surfaces as
 * "the digest handed to recoverSigner is not the one this run hashes to" on an innocent run.
 * So this module supplies the deadline by reading the *same* record, which is the only way the
 * two agree while the field exists. When `RunFacts` loses it, `ChainRunFacts` becomes
 * `RunFacts` and `toRunFacts` disappears with the concern.
 */

/** The chain-readable half of `RunFacts`. */
export type ChainRunFacts = Omit<RunFacts, "sigDeadline">;

/** The reads `assembleChainFacts` performs, so a test can supply facts without a node. */
export interface TrialReader {
  readonly address: Address;
  readonly chainId: number;
  trial(trialId: number): Promise<{ agentId: number; runHash: Hex; status: number }>;
  runner(agentId: number): Promise<Address>;
}

/**
 * A trial is only verifiable if it was actually run: an unassigned agent or a zero run hash
 * means the break arrived before any claim, and there are no bytes to re-execute. Abstaining
 * is the honest answer, and this is the case where the seat knows before it spends a bench.
 */
export const NO_RUN_HASH: Hex = `0x${"00".repeat(32)}`;

export function isVerifiable(trial: { agentId: number; runHash: Hex }): boolean {
  return trial.agentId !== 0 && trial.runHash !== NO_RUN_HASH;
}

export async function assembleChainFacts(reader: TrialReader, trialId: number): Promise<ChainRunFacts> {
  const trial = await reader.trial(trialId);
  if (!isVerifiable(trial)) {
    throw new Error(`trial ${trialId} has no run to verify (agentId ${trial.agentId}, runHash ${trial.runHash})`);
  }
  return {
    trialId,
    agentId: trial.agentId,
    runHash: trial.runHash,
    chainId: reader.chainId,
    verifyingContract: reader.address,
    runner: await reader.runner(trial.agentId),
  };
}

/**
 * The one content-store read the assembly needs, and it is a workaround for a duplicate field.
 *
 * `recordForRun` returns null when the runner never published the bytes. That is not fatal
 * here — the verifier abstains on exactly that evidence, with the disclosure step named in its
 * report — so a missing record fills the deadline with zero and lets the honest abstention be
 * produced by the component that owns the verdict rather than by this one.
 */
export async function toRunFacts(chainFacts: ChainRunFacts, content: ContentService): Promise<RunFacts> {
  const record = await content.recordForRun(chainFacts.runHash);
  return { ...chainFacts, sigDeadline: BigInt(record?.sigDeadline ?? "0") };
}
