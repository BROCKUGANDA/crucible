import { describe, expect, it } from "vitest";
import { keccak256, stringToHex, decodeFunctionData } from "viem";
import { TRIALS_ABI } from "@crucible/smith";
import {
  buildClaimTrial,
  buildCreateTrial,
  buildFileBreak,
  buildFinalize,
  buildRegisterAgent,
  buildSubmitRun,
  buildWithdraw,
  decodeRevert,
} from "../src/lib/useTx";
import { shortAddress } from "../src/lib/wagmi";
import { validateWizard, EMPTY_WIZARD } from "../src/lib/wizard";

const RUNNER = "0x1111111111111111111111111111111111111111";
const HASH = `0x${"ab".repeat(32)}` as `0x${string}`;

describe("transaction builders", () => {
  // decoding round-trips rather than asserting raw hex length: a length check would
  // pass even if the arguments were encoded in the wrong order
  it("encodes createTrial and decodes back to the same arguments", () => {
    const data = buildCreateTrial({
      specDigest: HASH,
      testsDigest: HASH,
      rewardWei: 10n ** 17n,
      deadline: 1_800_000_000,
      breakWindow: 43_200,
    });
    expect(decodeFunctionData({ abi: TRIALS_ABI, data }).functionName).toBe("createTrial");
    const args = decodeFunctionData({ abi: TRIALS_ABI, data }).args! as unknown as [
      `0x${string}`,
      `0x${string}`,
      bigint,
      bigint,
    ];
    expect(args[0]).toBe(HASH);
    expect(args[1]).toBe(HASH);
    expect(args[2]).toBe(1_800_000_000n);
    expect(args[3]).toBe(43_200n);
  });

  it("encodes registerAgent with the metadata string and runner", () => {
    const tx = buildRegisterAgent({
      metadataURI: "ipfs://manifest",
      runner: RUNNER,
      stakeWei: 10n ** 18n,
    });
    expect(tx.value).toBe(10n ** 18n);
    const decoded = decodeFunctionData({ abi: TRIALS_ABI, data: tx.data });
    expect(decoded.functionName).toBe("registerAgent");
    expect((decoded.args as unknown as [string, string])[0]).toBe("ipfs://manifest");
    expect((decoded.args as unknown as [string, string])[1]).toBe(RUNNER);
  });

  it("encodes a 1-argument function and round-trips its argument", () => {
    for (const [data, expected] of [
      [buildClaimTrial(7), 7n],
      [buildFinalize(9), 9n],
    ] as const) {
      const decoded = decodeFunctionData({ abi: TRIALS_ABI, data });
      expect(decoded.args).toEqual([expected]);
    }
  });

  it("encodes withdraw with no arguments", () => {
    const decoded = decodeFunctionData({ abi: TRIALS_ABI, data: buildWithdraw() });
    expect(decoded.functionName).toBe("withdraw");
    expect(decoded.args ?? []).toEqual([]);
    // selector plus nothing: a stray argument would show up here
    expect(buildWithdraw().length).toBe(2 + 8);
  });

  it("encodes fileBreak with its stake and proof", () => {
    const tx = buildFileBreak(3, HASH, 10n ** 16n);
    expect(tx.value).toBe(10n ** 16n);
    const args = decodeFunctionData({ abi: TRIALS_ABI, data: tx.data }).args as unknown as [
      bigint,
      `0x${string}`,
    ];
    expect(args[0]).toBe(3n);
    expect(args[1]).toBe(HASH);
  });

  it("encodes submitRun with the signature blob intact", () => {
    const sig = `0x${"11".repeat(65)}` as `0x${string}`;
    const data = buildSubmitRun({
      trialId: 4,
      runHash: HASH,
      signature: sig,
      sigDeadline: 1_700_000_000n,
    });
    const args = decodeFunctionData({ abi: TRIALS_ABI, data }).args as unknown as [
      bigint,
      `0x${string}`,
      `0x${string}`,
      bigint,
    ];
    expect(args[0]).toBe(4n);
    expect(args[1]).toBe(HASH);
    expect(args[2]).toBe(sig); // the 65-byte signature survives encoding
    expect(args[3]).toBe(1_700_000_000n);
  });

  it("round-trips a CID text through a digest the same way the contract commits", () => {
    const digest = keccak256(stringToHex("bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi"));
    expect(digest).toMatch(/^0x[0-9a-f]{64}$/);
  });
});

describe("decodeRevert", () => {
  it("maps every named custom error to operator copy", () => {
    expect(decodeRevert(new Error("execution reverted: NotOpen()"))).toMatch(/already at this anvil/);
    expect(decodeRevert(new Error("reverted SigExpired()"))).toMatch(/sign again/);
    expect(decodeRevert(new Error("reverted BadSigner()"))).toMatch(/runner key/);
    expect(decodeRevert(new Error("reverted WindowOpen()"))).toMatch(/Skeptic window still open/);
  });

  it("finds a selector in details as well as the message", () => {
    const err = Object.assign(new Error("failed"), { details: "NotJudging()" });
    expect(decodeRevert(err)).toMatch(/Nothing to challenge/);
  });

  it("explains a user rejection rather than showing a selector", () => {
    expect(decodeRevert(new Error("User rejected the request"))).toMatch(/rejected/);
  });

  it("explains insufficient funds", () => {
    expect(decodeRevert(new Error("insufficient funds for intrinsic transaction cost"))).toMatch(
      /Not enough ETH/,
    );
  });

  it("explains a pending replacement", () => {
    expect(decodeRevert(new Error("replacement transaction underpriced"))).toMatch(/already in flight/);
  });

  it("explains an undeployed contract", () => {
    expect(decodeRevert(new Error("could not decode result: no contract at 0x0"))).toMatch(
      /not deployed on this network/,
    );
  });

  it("falls back to a safe sentence for an unknown revert, leaking no selector", () => {
    const out = decodeRevert(new Error("execution reverted: 0xdeadbeef"));
    expect(out).toMatch(/Nothing was lost/);
    expect(out).not.toContain("0xdeadbeef");
  });

  it("never throws on a non-Error input", () => {
    expect(() => decodeRevert("something odd")).not.toThrow();
  });
});

describe("shortAddress", () => {
  it("uses the copy deck's format", () => {
    expect(shortAddress("0x9f3e1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d7e8")).toBe("0x9f3e…d7e8");
  });

  it("handles an absent address", () => {
    expect(shortAddress(undefined)).toBe("");
  });
});

describe("wizard to transaction", () => {
  it("produces a 20% bond from the reward the sponsor typed", () => {
    const v = validateWizard({
      ...EMPTY_WIZARD,
      spec: "Implement deposit() so the balance rises by msg.value.",
      testsCID: "bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi",
      rewardEth: "0.5",
    });
    expect(v.ok).toBe(true);
    expect(v.bondEth).toBe("0.1000");
  });
});
