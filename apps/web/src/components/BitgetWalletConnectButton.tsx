"use client";

import { useEffect, useState } from "react";
import { useAccount, useConnect } from "wagmi";
import { bitgetProvider } from "@/lib/bitget";
import { chainForWallets } from "@/lib/wagmi";
import { ensureChain, type Eip1193Provider } from "@/lib/chainSwitch";
import { haptics, vibrate } from "@/lib/forge";

/**
 * Explicit Bitget button for the no-WalletConnect configuration.
 * RainbowKit lists the same connector through the custom wallet descriptor
 * when a WalletConnect project id is configured.
 */
export function BitgetWalletConnectButton() {
  const { address } = useAccount();
  const { connectAsync, connectors, isPending } = useConnect();
  const [available, setAvailable] = useState(false);
  const [connecting, setConnecting] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);

  useEffect(() => {
    setAvailable(Boolean(bitgetProvider()));
  }, []);

  const connector = connectors.find((item) => item.id === "wallet.bitget.com");

  if (!available || !connector || address) return null;

  const connect = async () => {
    setFailure(null);
    setConnecting(true);
    try {
      await connectAsync({ connector });
      const provider = (await connector.getProvider()) as Eip1193Provider;
      const result = await ensureChain(provider, chainForWallets());
      if (!result.ok) {
        setFailure(`Connected, but this trial needs ${chainForWallets().name}: ${result.message}`);
      }
    } catch (error) {
      setFailure(error instanceof Error ? error.message.split("\n")[0]! : String(error));
    } finally {
      setConnecting(false);
    }
  };

  return (
    <span className="wallet-inline">
      <button
        className="btn btn-ghost"
        disabled={isPending || connecting}
        aria-label="Connect Bitget Wallet"
        title="Connect Bitget Wallet"
        onClick={() => {
          vibrate(haptics.bondStaked, true);
          void connect();
        }}
      >
        {isPending || connecting ? "Connecting…" : "Bitget Wallet"}
      </button>
      {failure ? (
        <span className="mono" data-tone="sear" role="alert">
          {failure}
        </span>
      ) : null}
    </span>
  );
}
