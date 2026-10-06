import path from "node:path";
import { fileURLToPath } from "node:url";

/** @type {import('next').NextConfig} */

const here = path.dirname(fileURLToPath(import.meta.url));

// `@wagmi/connectors` exports every connector from one barrel, and some of those
// connectors reach into packages we neither install nor use. Webpack resolves the whole
// barrel regardless, then fails on their undeclared peers. Nothing in Crucible can ever
// reach this code — we use injected wallets and WalletConnect — so the unused subtrees
// are cut from the module graph here.
//
//   * `@base-org/account` -> `@coinbase/cdp-sdk` -> the optional `@x402/*` payment stack
//   * `@metamask/sdk` imports `@react-native-async-storage/*`, a React Native peer that
//     does not belong in a browser bundle
//
// Aliasing the *entry points* to `false` drops entire subtrees in one move, rather than
// chasing whichever leaf subpath fails first. A non-`$` key also matches subpaths.
//
// Remove these when `@wagmi/connectors` stops re-exporting the whole connector set from
// its root barrel, or when the upstream packages declare their peers properly.
const UNUSED_WALLET_SUBTREES = [
  "@base-org/account",
  "@coinbase/cdp-sdk",
  "@react-native-async-storage/async-storage",
  "@react-native-async-storage",
];

const nextConfig = {
  reactStrictMode: true,
  transpilePackages: ["@crucible/smith", "@crucible/indexer"],

  // This is a monorepo; without this Next picks whichever lockfile it finds first,
  // which on this machine is an unrelated one in the home directory.
  outputFileTracingRoot: path.join(here, "..", ".."),

  webpack: (config) => {
    for (const pkg of UNUSED_WALLET_SUBTREES) {
      config.resolve.alias[pkg] = false;
    }
    return config;
  },
};

export default nextConfig;