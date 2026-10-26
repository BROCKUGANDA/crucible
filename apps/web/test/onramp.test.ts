import { describe, expect, it } from "vitest";
import { onrampUrl } from "../src/lib/onramp.js";

const ADDRESS = "0x" + "ab".repeat(20);

describe("sponsor on-ramp", () => {
  it("is hidden when no provider URL is configured", () => {
    expect(onrampUrl({ chainId: 1 }, "")).toBeNull();
    expect(onrampUrl({ chainId: 1 }, "   ")).toBeNull();
    expect(onrampUrl({ chainId: 1 }, undefined)).toBeNull();
  });

  it("refuses a non-https or unparseable provider URL", () => {
    expect(onrampUrl({ chainId: 1 }, "http://pay.example/buy")).toBeNull();
    expect(onrampUrl({ chainId: 1 }, "javascript:alert(1)")).toBeNull();
    expect(onrampUrl({ chainId: 1 }, "not a url")).toBeNull();
  });

  it("carries the sponsor address and the chain id", () => {
    const url = new URL(onrampUrl({ address: ADDRESS, chainId: 1 }, "https://pay.example/buy")!);
    expect(url.origin + url.pathname).toBe("https://pay.example/buy");
    expect(url.searchParams.get("address")).toBe(ADDRESS);
    expect(url.searchParams.get("chainId")).toBe("1");
  });

  it("keeps the provider's own query parameters", () => {
    const url = new URL(
      onrampUrl({ address: ADDRESS, chainId: 1 }, "https://pay.example/buy?appId=demo&asset=ETH")!,
    );
    expect(url.searchParams.get("appId")).toBe("demo");
    expect(url.searchParams.get("asset")).toBe("ETH");
    expect(url.searchParams.get("address")).toBe(ADDRESS);
  });

  it("does not put a malformed address on the link", () => {
    const url = new URL(onrampUrl({ address: "not-an-address", chainId: 1 }, "https://pay.example/buy")!);
    expect(url.searchParams.has("address")).toBe(false);
    expect(url.searchParams.get("chainId")).toBe("1");
  });
});
