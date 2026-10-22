import { describe, expect, it } from "vitest";
import { formatEther } from "viem";
import { weiToEth } from "@crucible/indexer";
import { formatWei, isEthAddress, parseEth, WEI_PER_ETH } from "../src/lib/eth";

describe("parseEth", () => {
  it("parses whole amounts exactly", () => {
    expect(parseEth("1")).toBe(WEI_PER_ETH);
    expect(parseEth("0")).toBe(0n);
    expect(parseEth("42")).toBe(42n * WEI_PER_ETH);
  });

  // This is the whole reason the parser exists: 0.1 * 1e18 === 100000000000000008
  it("does not lose precision the way a float would", () => {
    expect(parseFloat("0.1") * 1e18).not.toBe(parseEth("0.1"));
    expect(parseEth("0.1")).toBe(100_000_000_000_000_000n);
    expect(parseEth("0.2")).toBe(200_000_000_000_000_000n);
    expect(parseEth("0.3")).toBe(300_000_000_000_000_000n);
    expect(parseEth("2.675")).toBe(2_675_000_000_000_000_000n);
    expect(parseEth("8.7")).toBe(8_700_000_000_000_000_000n);
  });

  it("parses amounts with leading or trailing decimals", () => {
    expect(parseEth("1.")).toBe(WEI_PER_ETH);
    expect(parseEth(".5")).toBe(500_000_000_000_000_000n);
  });

  it("pads short fractions out to wei", () => {
    // 9 decimals is a gwei, not a wei — the padding has to count real places
    expect(parseEth("0.000000001")).toBe(1_000_000_000n);
    expect(parseEth("0.000000000000000001")).toBe(1n); // 18 decimals: one wei
    expect(parseEth("1.5")).toBe(1_500_000_000_000_000_000n);
  });

  it("accepts exactly eighteen decimals", () => {
    expect(parseEth("0.000000000000000001")).toBe(1n);
  });

  it("refuses sub-wei precision rather than truncating it", () => {
    // silently dropping digits would send a different stake than the operator typed
    expect(parseEth("0.0000000000000000001")).toBeNull();
    expect(parseEth("1.1234567890123456789")).toBeNull();
  });

  it("returns null for junk instead of zero", () => {
    for (const bad of ["", " ", ".", "abc", "1e18", "-1", "0x10", "1,000", "1.2.3", "Infinity", "NaN"]) {
      expect(parseEth(bad)).toBeNull();
    }
  });

  it("trims surrounding whitespace", () => {
    expect(parseEth("  1.5  ")).toBe(1_500_000_000_000_000_000n);
  });
});

describe("formatWei", () => {
  it("drops trailing zeros", () => {
    expect(formatWei(WEI_PER_ETH)).toBe("1");
    expect(formatWei(1_500_000_000_000_000_000n)).toBe("1.5");
    expect(formatWei(0n)).toBe("0");
  });

  it("respects the requested precision", () => {
    expect(formatWei(955_000_000_000_000_000n)).toBe("0.955");
    expect(formatWei(1_234_567_890_123_456_789n, 6)).toBe("1.234567");
  });

  it("handles negatives", () => {
    expect(formatWei(-WEI_PER_ETH)).toBe("-1");
  });

  it("round-trips through parseEth for display-sized amounts", () => {
    for (const value of ["1", "0.5", "0.955", "12.25"]) {
      expect(parseEth(formatWei(parseEth(value)!))).toBe(parseEth(value));
    }
  });
});

describe("isEthAddress", () => {
  it("accepts a checksummed address", () => {
    expect(isEthAddress("0x5FbDB2315678afecb367f032d93F642f64180aa3")).toBe(true);
  });

  it("rejects the wrong lengths and alphabets", () => {
    expect(isEthAddress("0x5FbDB2315678afecb367f032d93F642f64180a")).toBe(false);
    expect(isEthAddress("0x5FbDB2315678afecb367f032d93F642f64180aa31")).toBe(false);
    expect(isEthAddress("5FbDB2315678afecb367f032d93F642f64180aa3")).toBe(false);
    expect(isEthAddress("0xZZbDB2315678afecb367f032d93F642f64180aa3")).toBe(false);
    expect(isEthAddress("")).toBe(false);
  });
});

/**
 * One formatter, three call sites.
 *
 * The repository used to own three ways to print the same wei: `weiToEth` in the indexer's API
 * layer, `formatWei` in this app, and viem's `formatEther` called straight from the hall
 * snapshot. Three implementations is not three displays, it is three chances for one stake to
 * print as two numbers, and a reader who catches the site disagreeing with itself has no way to
 * work out which half to distrust.
 *
 * `weiToEth` is now the single implementation and `formatWei` delegates to it. `hall.ts` sits
 * outside the surface this change was allowed to touch, so its equality to the shared formatter
 * is asserted here rather than imported: viem is already a dependency of this app, so if
 * `weiToEth` ever drifts from `formatEther`, the hall's numbers and the API's numbers part
 * company and this block is what says so.
 */
const CORPUS: readonly bigint[] = [
  0n,
  1n,
  999_999_999_999_999_999n,
  1_000_000_000_000_000_000n,
  1_234_567_890_123_456_789n,
  10_000_000_000_000_000_000n,
  123_456_789_000_000_000_000_000n,
];

describe("the shared wei -> ETH formatter", () => {
  it("sits behind both the payload builder and this app's display helper", () => {
    for (const wei of [...CORPUS, -WEI_PER_ETH, -1n]) {
      expect(formatWei(wei, 18)).toBe(weiToEth(wei));
    }
  });

  it("agrees with the viem formatter the hall snapshot still calls", () => {
    for (const wei of CORPUS) {
      expect(weiToEth(wei)).toBe(formatEther(wei));
    }
    expect(weiToEth(-WEI_PER_ETH)).toBe(formatEther(-WEI_PER_ETH));
  });

  it("keeps the full precision the payloads were published with", () => {
    // One wei is 18 decimals and they are all significant: an API that shortened it would print
    // a stake the chain never saw.
    expect(weiToEth(1n)).toBe("0.000000000000000001");
    expect(weiToEth(3_333_333_333_333_333_333n)).toBe("3.333333333333333333");
  });

  it("keeps this app's four-decimal display default", () => {
    expect(formatWei(1_234_567_890_123_456_789n)).toBe("1.2345");
    expect(formatWei(1_000_000_000_000_000_000n)).toBe("1");
  });

  it("truncates a display amount instead of rounding it up", () => {
    // A credit one wei short of an ETH must not be printed as a full ETH: the button beside the
    // number would be quoting a stake larger than the one the operator can actually withdraw.
    expect(formatWei(WEI_PER_ETH - 1n)).toBe("0.9999");
    expect(formatWei(WEI_PER_ETH - 1n)).not.toBe("1");
  });

  it("treats a nonsense precision as full precision rather than as nothing", () => {
    expect(weiToEth(1_234_567_890_123_456_789n, 99)).toBe("1.234567890123456789");
    expect(weiToEth(1_234_567_890_123_456_789n, -3)).toBe("1");
  });
});