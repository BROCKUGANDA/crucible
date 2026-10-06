"use client";

import { type ReactNode } from "react";
import { WagmiProvider } from "wagmi";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { RainbowKitProvider, darkTheme } from "@rainbow-me/rainbowkit";
import { rainbowKitProjectId, wagmiConfig } from "@/lib/wagmi";
import { forge } from "@/lib/forge";

/**
 * Provider stack.
 *
 * `WagmiProvider` is mounted unconditionally. It could be skipped when no deployment is
 * configured, but then every page's wagmi hooks would throw during prerender and the
 * build would fail on a fresh clone — a build that needs secrets before it compiles is
 * bad for a developer and worse on stage. Signing is refused later, by `useTx.send`,
 * where refusing can say something useful.
 *
 * RainbowKit's provider is genuinely conditional: without a WalletConnect project id
 * its modal has nothing to connect through, so the app falls back to plain injected
 * connectors (see Wallet.tsx).
 */

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      // the read model changes with the chain; polling faster than this is waste
      staleTime: 3_000,
      refetchOnWindowFocus: true,
      retry: 1,
    },
  },
});

/** RainbowKit's theme, mapped onto the Industrial Forge tokens. */
const rainbowTheme = darkTheme({
  accentColor: forge.ember,
  accentColorForeground: "#1a0d05",
  borderRadius: "medium",
  fontStack: "system",
  overlayBlur: "small",
});

export function Providers({ children }: { children: ReactNode }) {
  const withRainbowKit = rainbowKitProjectId().length > 0;

  return (
    <WagmiProvider config={wagmiConfig()}>
      <QueryClientProvider client={queryClient}>
        {withRainbowKit ? (
          <RainbowKitProvider modalSize="compact" theme={rainbowTheme}>
            {children}
          </RainbowKitProvider>
        ) : (
          children
        )}
      </QueryClientProvider>
    </WagmiProvider>
  );
}

export { QueryClient };