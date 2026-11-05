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

/**
 * RainbowKit wallet descriptor. The connector still delegates signing to
 * Bitget; this descriptor only provides the wallet-picker presentation.
 */
export function bitgetWallet() {
  return {
    id: "bitget",
    name: "Bitget Wallet",
    iconUrl:
      "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 40 40'%3E%3Crect width='40' height='40' rx='10' fill='%230f172a'/%3E%3Cpath d='M11 10h18v6H17v3h8v5h-8v3h12v6H11z' fill='%23fff'/%3E%3C/svg%3E",
    iconBackground: "#0f172a",
    installed: Boolean(bitgetProvider()),
    downloadUrls: {
      browserExtension: "https://web3.bitget.com/en/wallet-download?type=2",
    },
    createConnector: () => bitgetConnector(),
  };
}
