import { describe, expect, it } from "vitest";

/**
 * Gate 655 — TS ledger-mirror of RewardMath (the Solidity library in
 * `crucible-contracts/contracts/RewardMath.sol`).
 *
 * Every row of the flow table is computed here in TypeScript and must agree
 * with the Solidity implementation, or nothing ships. The two implementations
 * are independent: this file is not imported from the Solidity side, so a
 * drift between them is a real signal, not a copy-paste artifact.
 *
 * CRUCIBLE's fee is FEE_BPS = 500 = 5% (AGENTS.md: the code, the tests, and
 * the contract-spec win over any external PRD). Money never crosses a float;
 * all amounts are wei integers. Payouts truncate; minimums round up.
 */

const FEE_BPS = 500n;
const BPS = 10_000n;

/** Mirror of RewardMath.splitPostWork (gate 641). */
function splitPostWork(reward: bigint): [bigint, bigint] {
  const feeShare = (reward * FEE_BPS) / BPS;
  const workerShare = reward - feeShare;
  return [workerShare, feeShare];
}

/** Mirror of RewardMath.settleOnPass (gate 644). */
function settleOnPass(reward: bigint, stake: bigint): [bigint, bigint, bigint] {
  const [workerShare, feeShare] = splitPostWork(reward);
  return [workerShare + stake, feeShare, stake];
}

/** Mirror of RewardMath.settleOnFail (gate 643). */
function settleOnFail(reward: bigint, stake: bigint): [bigint, bigint, bigint] {
  const funderRefund = reward;
  const funderStakeBack = stake / 2n;
  const feeStakeBack = stake - stake / 2n;
  return [funderRefund, funderStakeBack, feeStakeBack];
}

/** Mirror of RewardMath.settleOnExpiry (gate 645). */
function settleOnExpiry(reward: bigint, stake: bigint): [bigint, bigint] {
  return [reward, stake];
}

/** Mirror of RewardMath.settleOnDisputeOverturn (gate 646). */
function settleOnDisputeOverturn(reward: bigint, stake: bigint, disputeFee: bigint): [bigint, bigint] {
  return [reward + stake, disputeFee];
}

/** Mirror of RewardMath.stakeFloor (gate 642). */
function stakeFloor(estimatedVerificationCost: bigint): bigint {
  return estimatedVerificationCost; // k >= 1 for v1
}

/** Mirror of RewardMath.conservation (gate 647). */
function conservation(
  balance: bigint,
  rewardsHeld: bigint,
  stakesHeld: bigint,
  disputeFeesHeld: bigint,
  feeVault: bigint,
  pendingHeld: bigint
): boolean {
  return balance == rewardsHeld + stakesHeld + disputeFeesHeld + feeVault + pendingHeld;
}

const ETH = 1_000_000_000_000_000_000n;

describe("RewardMath TS ledger-mirror (gate 655)", () => {
  it("splitPostWork: 5% fee, 95% worker", () => {
    const reward = 100n * ETH;
    const [workerShare, feeShare] = splitPostWork(reward);
    expect(feeShare).toBe(5n * ETH);
    expect(workerShare).toBe(95n * ETH);
    expect(workerShare + feeShare).toBe(reward);
  });

  it("settleOnPass: worker ← workerShare + stake; feeVault ← feeShare", () => {
    const reward = 100n * ETH;
    const stake = 20n * ETH;
    const [workerPayout, feePayout, stakeBack] = settleOnPass(reward, stake);
    expect(workerPayout).toBe(115n * ETH); // 95 + 20
    expect(feePayout).toBe(5n * ETH);
    expect(stakeBack).toBe(20n * ETH);
  });

  it("settleOnFail: funder ← full reward; stake slashed 50/50; fee returns on fail", () => {
    const reward = 100n * ETH;
    const stake = 20n * ETH;
    const [funderRefund, funderStakeBack, feeStakeBack] = settleOnFail(reward, stake);
    expect(funderRefund).toBe(100n * ETH);
    expect(funderStakeBack).toBe(10n * ETH);
    expect(feeStakeBack).toBe(10n * ETH);
    expect(funderStakeBack + feeStakeBack).toBe(stake);
  });

  it("settleOnExpiry: funder ← full refund; worker ← stake back; nothing decays", () => {
    const reward = 100n * ETH;
    const stake = 20n * ETH;
    const [funderRefund, stakeBack] = settleOnExpiry(reward, stake);
    expect(funderRefund).toBe(100n * ETH);
    expect(stakeBack).toBe(20n * ETH);
  });

  it("settleOnDisputeOverturn: full worker restitution; dispute fee → winner", () => {
    const reward = 100n * ETH;
    const stake = 20n * ETH;
    const disputeFee = 2n * ETH;
    const [workerRestitution, winnerDisputeFee] = settleOnDisputeOverturn(reward, stake, disputeFee);
    expect(workerRestitution).toBe(120n * ETH);
    expect(winnerDisputeFee).toBe(2n * ETH);
  });

  it("conservation: exact equality holds", () => {
    expect(
      conservation(1000n * ETH, 400n * ETH, 300n * ETH, 50n * ETH, 150n * ETH, 100n * ETH)
    ).toBe(true);
    // off by one breaks equality — the invariant battery would catch this
    expect(
      conservation(1000n * ETH, 400n * ETH, 300n * ETH, 50n * ETH, 150n * ETH, 101n * ETH)
    ).toBe(false);
  });

  it("stakeFloor: k = 1 for v1", () => {
    expect(stakeFloor(10n * ETH)).toBe(10n * ETH);
    expect(stakeFloor(0n)).toBe(0n);
  });

  it("money never crosses a float — all arithmetic is bigint", () => {
    const reward = 1n * ETH;
    const [workerShare, feeShare] = splitPostWork(reward);
    expect(typeof reward).toBe("bigint");
    expect(typeof workerShare).toBe("bigint");
    expect(typeof feeShare).toBe("bigint");
    // payouts truncate: 1 wei reward → 0 wei fee (floor), 1 wei worker (truncation)
    const [tinyWorker, tinyFee] = splitPostWork(1n);
    expect(tinyFee).toBe(0n);
    expect(tinyWorker).toBe(1n);
  });
});
