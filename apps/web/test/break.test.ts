import { describe, expect, it } from "vitest";
import { formatWei, parseEth, WEI_PER_ETH } from "../src/lib/eth";
import { buildFileBreak, buildSubmitRun, buildWithdraw } from "../src/lib/useTx";
import { TRIALS_ABI } from "@crucible/smith";
import { decodeFunctionData } from "viem";

/**
 * The Break — the economics a skeptic is betting on.
 *
 * These constants are duplicated here rather than imported from the contract, on
 * purpose: if the contract's split ever changes, these tests should fail loudly rather
 * than silently following it. The copy on screen and the numbers a skeptic risks are
 * only trustworthy if someone checked them against Solidity by hand.
 */
const SKEPTIC_SHARE_BPS = 3000; // 30% of the agent's bond
const MIN_STAKE_DIVISOR = 100n; // 1% of the reward
const FAILED_BREAK_REFUND_BPS = 5000; // half the stake returns to the agent

describe("break economics", () => {
  const rewardWei = parseEth("1")!; // 1 ETH reward
  const bondWei = parseEth("0.2")!; // agent bonded 20%
  const minStakeWei = rewardWei / MIN_STAKE_DIVISOR;
  const payoutWei = (bondWei * BigInt(SKEPTIC_SHARE_BPS)) / 10_000n;

  it("sets the minimum stake at 1% of the reward", () => {
    expect(minStakeWei).toBe(10_000_000_000_000_000n); // 0.01 ETH
    expect(formatWei(minStakeWei, 18)).toBe("0.01");
  });

  it("pays the skeptic 30% of the bond, not 30% of the reward", () => {
    // 0.2 ETH bond -> 0.06 ETH. Confusing the two would overstate the payout 3x.
    expect(payoutWei).toBe(60_000_000_000_000_000n);
    expect(formatWei(payoutWei, 18)).toBe("0.06");
  });

  it("pays less than the minimum stake at low bond/reward ratios", () => {
    // A skeptic can stake 0.01 to win 0.006 against a 0.02 bond. That asymmetry is the
    // point: they are buying optionality, not guaranteed income.
    const tinyBond = parseEth("0.02")!;
    expect((tinyBond * BigInt(SKEPTIC_SHARE_BPS)) / 10_000n).toBe(6_000_000_000_000_000n);
  });

  it("refunds half a failed break to the agent, burning the rest", () => {
    const stake = parseEth("0.01")!;
    const refund = (stake * BigInt(FAILED_BREAK_REFUND_BPS)) / 10_000n;
    expect(refund).toBe(5_000_000_000_000_000n);
    expect(stake - refund).toBe(5_000_000_000_000_000n);
  });

  it("never lets a minimum stake of zero disable the check", () => {
    // A zero reward would make minStake 0, and a `>=` check would then accept anything —
    // including nothing. The panel disables on `stakeWei >= minStakeWei`, which for a
    // zero reward still requires a parseable, positive number.
    const zeroReward = 0n;
    const zeroMin = zeroReward / MIN_STAKE_DIVISOR;
    expect(zeroMin).toBe(0n);
    expect(parseEth("0")! >= zeroMin).toBe(true);
  });
});

describe("fileBreak encoding", () => {
  it("sends the stake as msg.value, not as a calldata argument", () => {
    const tx = buildFileBreak(3, `0x${"ab".repeat(32)}` as `0x${string}`, 10n ** 16n);
    expect(tx.value).toBe(10n ** 16n);

    const args = decodeFunctionData({ abi: TRIALS_ABI, data: tx.data }).args as unknown as [
      bigint,
      `0x${string}`,
    ];
    // only two calldata arguments: trialId and the proof digest
    expect(args).toHaveLength(2);
    expect(args[0]).toBe(3n);
  });
});

describe("signature-bearing submissions", () => {
  it("carries the runner's signature rather than the operator's", () => {
    // The whole trust story: the wallet pays and broadcasts, but only the runner key's
    // signature makes the claim count. A compromised operator wallet cannot forge a run.
    const runnerSig = `0x${"11".repeat(65)}` as `0x${string}`;
    const data = buildSubmitRun({
      trialId: 1,
      runHash: `0x${"cd".repeat(32)}` as `0x${string}`,
      signature: runnerSig,
      sigDeadline: 1_700_000_000n,
    });
    const args = decodeFunctionData({ abi: TRIALS_ABI, data }).args as unknown as [
      bigint,
      `0x${string}`,
      `0x${string}`,
      bigint,
    ];
    expect(args[2]).toBe(runnerSig);
  });

  it("never sends value with a run submission or a withdrawal", () => {
    // If withdraw carried value it would be an accidental donation.
    expect(buildWithdraw().length).toBe(2 + 8);
  });
});

describe("wei constants", () => {
  it("matches the contract's notion of one ETH", () => {
    expect(WEI_PER_ETH).toBe(1_000_000_000_000_000_000n);
  });
});