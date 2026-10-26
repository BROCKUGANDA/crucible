import { describe, expect, it } from "vitest";
import { addChainParams, chainIdHex, ensureChain, type ChainDescription } from "../src/lib/chainSwitch.js";

/**
 * The chain the demo runs on does not exist in any consumer wallet, so "connect" is really
 * two requests: switch, and — only when the wallet answers 4902 — add. Every branch below is
 * a different way that pair can fail, and a caller that treats any of them as success asks
 * for a signature on a chain the wallet is not on.
 */

const ANVIL: ChainDescription = {
  chainId: 31337,
  name: "Anvil",
  rpcUrl: "https://crucible.svalley.tech/anvil",
  nativeCurrency: { name: "Test Ether", symbol: "ETH", decimals: 18 },
};

class FakeWallet {
  calls: { method: string; params?: unknown[] }[] = [];
  constructor(
    private chain: number,
    private opts: {
      /** behaves as if the chain is unknown and must be added first */
      unknown?: boolean;
      /** what `add` does to the reported chain; null = does not switch */
      addSwitchesTo?: number | null;
      failSwitchWith?: { code: number; message: string };
      failAddWith?: { code: number; message: string };
      /** switch resolves but the wallet stays put */
      switchNoop?: boolean;
    } = {},
  ) {}

  readonly request = async ({ method, params }: { method: string; params?: unknown[] }) => {
    this.calls.push({ method, params });
    switch (method) {
      case "eth_chainId":
        return chainIdHex(this.chain);
      case "wallet_switchEthereumChain": {
        if (this.opts.failSwitchWith) throw this.opts.failSwitchWith;
        if (this.opts.unknown) throw { code: 4902, message: "Unrecognized chain ID" };
        if (!this.opts.switchNoop) this.chain = Number((params?.[0] as { chainId: string }).chainId);
        return null;
      }
      case "wallet_addEthereumChain": {
        if (this.opts.failAddWith) throw this.opts.failAddWith;
        this.opts.unknown = false;
        if (this.opts.addSwitchesTo != null) this.chain = this.opts.addSwitchesTo;
        return null;
      }
      default:
        throw new Error(`unexpected method ${method}`);
    }
  };
}

const methods = (w: FakeWallet) => w.calls.map((c) => c.method);

describe("landing the wallet on the deployment's chain", () => {
  it("does nothing when the wallet is already there", async () => {
    const w = new FakeWallet(31337);
    await expect(ensureChain(w, ANVIL)).resolves.toEqual({ ok: true, added: false });
    expect(methods(w)).toEqual(["eth_chainId"]);
  });

  it("switches a wallet that knows the chain", async () => {
    const w = new FakeWallet(1);
    await expect(ensureChain(w, ANVIL)).resolves.toEqual({ ok: true, added: false });
    expect(methods(w)).toEqual(["eth_chainId", "wallet_switchEthereumChain", "eth_chainId"]);
  });

  it("adds the chain when the wallet answers 4902", async () => {
    const w = new FakeWallet(1, { unknown: true, addSwitchesTo: 31337 });
    await expect(ensureChain(w, ANVIL)).resolves.toEqual({ ok: true, added: true });
    expect(methods(w)).toContain("wallet_addEthereumChain");
    const add = w.calls.find((c) => c.method === "wallet_addEthereumChain")!;
    // The RPC the visitor's browser can reach, not a loopback address.
    expect(add.params?.[0]).toMatchObject({
      chainId: "0x7a69",
      chainName: "Anvil",
      rpcUrls: ["https://crucible.svalley.tech/anvil"],
      nativeCurrency: { symbol: "ETH", decimals: 18 },
    });
  });

  it("switches after adding when the wallet does not follow the add", async () => {
    const w = new FakeWallet(1, { unknown: true, addSwitchesTo: null });
    await expect(ensureChain(w, ANVIL)).resolves.toEqual({ ok: true, added: true });
    expect(methods(w).filter((m) => m === "wallet_switchEthereumChain")).toHaveLength(2);
  });

  it("does not ask to add a chain the visitor just declined", async () => {
    const w = new FakeWallet(1, { failSwitchWith: { code: 4001, message: "User rejected the request." } });
    await expect(ensureChain(w, ANVIL)).resolves.toEqual({
      ok: false,
      code: 4001,
      message: "User rejected the request.",
    });
    // 4001 means no. Nagging with an add prompt would be a second dialog for the same answer.
    expect(methods(w)).not.toContain("wallet_addEthereumChain");
  });

  it("reports an add the wallet refused", async () => {
    const w = new FakeWallet(1, { unknown: true, failAddWith: { code: 4001, message: "Rejected" } });
    const out = await ensureChain(w, ANVIL);
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.code).toBe(4001);
  });

  it("fails when a wallet claims to switch and stays put", async () => {
    // `switch` resolved, the provider still reports chain 1, and `add` refuses to move it.
    const w = new FakeWallet(1, { switchNoop: true, failAddWith: { code: -32601, message: "Unsupported" } });
    const out = await ensureChain(w, ANVIL);
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.message).toContain("Unsupported");
  });

  it("surfaces a wallet that ended up on the wrong chain anyway", async () => {
    const w = new FakeWallet(1, { switchNoop: true, addSwitchesTo: 5 });
    const out = await ensureChain(w, ANVIL);
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.message).toContain("still not on it");
  });

  it("builds add params without an explorer when the chain has none", () => {
    // An Anvil chain has no block explorer; inventing one would produce a link to a page
    // that does not exist, which is worse than no link.
    expect(addChainParams(ANVIL)).not.toHaveProperty("blockExplorerUrls");
    expect(addChainParams({ ...ANVIL, explorerUrl: "https://example.test" })).toMatchObject({
      blockExplorerUrls: ["https://example.test"],
    });
  });
});
