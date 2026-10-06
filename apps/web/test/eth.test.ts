import { describe, expect, it } from "vitest";
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