/**
 * Landing the wallet on the chain this deployment actually runs.
 *
 * The demo runs on Anvil, chain 31337. No consumer wallet knows that chain id, so the first
 * signature a visitor attempts fails with a network error that reads like a broken site:
 * `wallet_switchEthereumChain` answers 4902 ("Unrecognized chain ID") and nothing tells the
 * reader the chain has to be added first. `wallet_addEthereumChain` is the missing half, and
 * the RPC URL it registers has to be the one *the visitor's browser* can reach — the deployed
 * value, not `127.0.0.1`, which would point the wallet at the visitor's own machine.
 *
 * These functions take the provider and the chain description as arguments rather than reading
 * hooks or environment at call time, so each branch below is exercised by a fake provider in
 * `test/chain-switch.test.ts` — including the branch where the wallet refuses.
 */

export interface Eip1193Provider {
  request(args: { method: string; params?: unknown[] }): Promise<unknown>;
}

export interface ChainDescription {
  chainId: number;
  name: string;
  /** Reachable from the browser showing the app; never a loopback address for a remote visitor. */
  rpcUrl: string;
  nativeCurrency: { name: string; symbol: string; decimals: number };
  explorerUrl?: string;
}

export type ChainOutcome =
  | { ok: true; added: boolean }
  | { ok: false; code: number | null; message: string };

export function chainIdHex(chainId: number): string {
  return "0x" + chainId.toString(16);
}

/** The payload `wallet_addEthereumChain` accepts (EIP-3085). */
export function addChainParams(chain: ChainDescription) {
  return {
    chainId: chainIdHex(chain.chainId),
    chainName: chain.name,
    rpcUrls: [chain.rpcUrl],
    nativeCurrency: chain.nativeCurrency,
    ...(chain.explorerUrl ? { blockExplorerUrls: [chain.explorerUrl] } : {}),
  };
}

function walletError(err: unknown): { code: number | null; message: string } {
  const code = typeof (err as { code?: unknown })?.code === "number" ? (err as { code: number }).code : null;
  const message =
    (typeof (err as { message?: unknown })?.message === "string" && (err as { message: string }).message) ||
    (err instanceof Error ? err.message : String(err)) ||
    "the wallet refused the request";
  // EIP-1193 wallets sometimes answer with a bare string or an object without a message.
  return { code, message: String(message).split("\n")[0]! };
}

async function currentChain(provider: Eip1193Provider): Promise<string | null> {
  try {
    const id = await provider.request({ method: "eth_chainId" });
    return typeof id === "string" ? id.toLowerCase() : null;
  } catch {
    return null;
  }
}

/**
 * Switch to `chain`, adding it first when the wallet does not know it.
 *
 * Order matters and is the whole point: switch is tried first because it is silent when the
 * wallet already has the chain; only 4902 earns a prompt to add one. Any other refusal — a
 * user declining with 4001, a wallet that does not implement the method — is returned, never
 * swallowed: a caller that ignores it goes on to ask for a signature on the wrong chain.
 */
export async function ensureChain(
  provider: Eip1193Provider,
  chain: ChainDescription,
): Promise<ChainOutcome> {
  const want = chainIdHex(chain.chainId);
  if ((await currentChain(provider)) === want) return { ok: true, added: false };

  try {
    await provider.request({ method: "wallet_switchEthereumChain", params: [{ chainId: want }] });
    // Some wallets resolve `switch` without actually moving; the account is only usable on
    // the chain it reports, so the answer comes from the provider, not from the promise.
    if ((await currentChain(provider)) === want) return { ok: true, added: false };
  } catch (err) {
    const { code, message } = walletError(err);
    if (code !== 4902) return { ok: false, code, message };
  }

  try {
    await provider.request({ method: "wallet_addEthereumChain", params: [addChainParams(chain)] });
  } catch (err) {
    const { code, message } = walletError(err);
    return { ok: false, code, message };
  }

  // Wallets differ on whether `add` also switches. Ask once more, and report the chain the
  // provider actually reports rather than the one we hoped for.
  if ((await currentChain(provider)) !== want) {
    try {
      await provider.request({ method: "wallet_switchEthereumChain", params: [{ chainId: want }] });
    } catch (err) {
      const { code, message } = walletError(err);
      return { ok: false, code, message };
    }
  }
  if ((await currentChain(provider)) !== want) {
    return { ok: false, code: null, message: `the wallet added ${chain.name} but is still not on it` };
  }
  return { ok: true, added: true };
}
