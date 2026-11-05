import { injected } from "wagmi/connectors";

/**
 * Bitget Wallet's EVM extension and in-app browser expose their EIP-1193
 * provider at window.bitkeep.ethereum. Do not assume it is window.ethereum:
 * users may have several wallets installed and the global can belong to another.
 */
export function bitgetProvider(): unknown {
  if (typeof window === "undefined") return undefined;
  return (window as unknown as { bitkeep?: { ethereum?: unknown } }).bitkeep?.ethereum;
}

/** A dedicated Wagmi connector target for Bitget's documented provider namespace. */
export function bitgetConnector() {
  return injected({
    shimDisconnect: true,
    target: {
      id: "wallet.bitget.com",
      name: "Bitget Wallet",
      provider: () => bitgetProvider() as never,
    },
  });
}
