import { afterAll, beforeEach, describe, expect, it } from "vitest";
import {
  activeChain,
  chainConfigured,
  chainFromId,
  chainLabel,
  CHAIN_IDS,
  deployment,
  environmentBadge,
  rpcUrl,
  ZERO_ADDRESS,
} from "../src/lib/networks";
// `activeChainDef` and the wallet config need the real chain objects, which live behind
// the viem chain barrel in `wagmi.ts` — the wallet-side module.
import { activeChainDef, buildConfig } from "../src/lib/wagmi";

/**
 * The three networks this build can ship to, and the differences that must survive the
 * shift between them: which chain id the wallet lands on, which contracts the build signs
 * against, which RPC it reads, and what the money warning says.
 *
 * `wagmi.ts` reads `process.env` at call time, so these tests set the environment
 * directly and restore it afterwards — no import-order tricks, no module cache resets.
 * Every assertion below names a branch: an env var that wins, a fallback that must not,
 * a typo that must degrade instead of crash. Each one is red if its branch is deleted.
 */

const ENV_VARS = [
  "NEXT_PUBLIC_CHAIN",
  "NEXT_PUBLIC_MAINNET_RPC",
  "NEXT_PUBLIC_SEPOLIA_RPC",
  "NEXT_PUBLIC_ANVIL_RPC",
  "NEXT_PUBLIC_TRIALS_ADDRESS",
  "NEXT_PUBLIC_ALLOY_ADDRESS",
  "NEXT_PUBLIC_MAINNET_TRIALS_ADDRESS",
  "NEXT_PUBLIC_MAINNET_ALLOY_ADDRESS",
  "NEXT_PUBLIC_SEPOLIA_TRIALS_ADDRESS",
  "NEXT_PUBLIC_SEPOLIA_ALLOY_ADDRESS",
  "NEXT_PUBLIC_ANVIL_TRIALS_ADDRESS",
  "NEXT_PUBLIC_ANVIL_ALLOY_ADDRESS",
] as const;

const SAVED = new Map(ENV_VARS.map((k) => [k, process.env[k]]));

beforeEach(() => {
  for (const k of ENV_VARS) delete process.env[k];
});

afterAll(() => {
  for (const [k, v] of SAVED) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

const TRIALS = "0x1111111111111111111111111111111111111111";
const ALLOY = "0x2222222222222222222222222222222222222222";
const MAINNET_TRIALS = "0x3333333333333333333333333333333333333333";
const MAINNET_ALLOY = "0x4444444444444444444444444444444444444444";

describe("network selection", () => {
  it("sepolia is the default when nothing is set", () => {
    expect(activeChain()).toBe("sepolia");
    expect(activeChainDef().id).toBe(CHAIN_IDS.sepolia);
  });

  it("maps each network to its chain definition", () => {
    process.env.NEXT_PUBLIC_CHAIN = "mainnet";
    expect(activeChain()).toBe("mainnet");
    expect(activeChainDef().id).toBe(1);

    process.env.NEXT_PUBLIC_CHAIN = "foundry";
    expect(activeChain()).toBe("foundry");
    expect(activeChainDef().id).toBe(31337);
  });

  it("degrades a mistyped network to the default instead of crashing three modules away", () => {
    // The value used to be cast blind: `NEXT_PUBLIC_CHAIN=seoplia` reached `rpcUrl` as
    // `CHAIN_IDS[undefined]` and blew up there. A config typo must fall back, not fall over.
    process.env.NEXT_PUBLIC_CHAIN = "seoplia";
    expect(activeChain()).toBe("sepolia");
    expect(rpcUrl()).toBe("https://ethereum-sepolia-rpc.publicnode.com");
  });
});

describe("environment badge", () => {
  it("names each network's money in plain words", () => {
    process.env.NEXT_PUBLIC_CHAIN = "foundry";
    expect(environmentBadge().label).toBe("LOCAL FORGE");
    expect(environmentBadge().title).toMatch(/no value/);

    process.env.NEXT_PUBLIC_CHAIN = "sepolia";
    expect(environmentBadge().label).toBe("TESTNET");
    expect(environmentBadge().title).toMatch(/No mainnet funds/);

    process.env.NEXT_PUBLIC_CHAIN = "mainnet";
    expect(environmentBadge().label).toBe("MAINNET");
    // The mainnet chip must not borrow the worthless-ETH sentence: there the value is real.
    expect(environmentBadge().title).toMatch(/real value/);
    expect(environmentBadge().title).not.toMatch(/no value/);
  });
});

describe("rpc per network", () => {
  it("reads only the configured RPC of the active network", () => {
    process.env.NEXT_PUBLIC_CHAIN = "mainnet";
    process.env.NEXT_PUBLIC_MAINNET_RPC = "https://my-mainnet-node.example";
    process.env.NEXT_PUBLIC_SEPOLIA_RPC = "https://my-sepolia-node.example";
    expect(rpcUrl()).toBe("https://my-mainnet-node.example");
  });

  it("falls back to a public endpoint when the network's RPC is unset", () => {
    process.env.NEXT_PUBLIC_CHAIN = "mainnet";
    expect(rpcUrl()).toBe("https://ethereum-rpc.publicnode.com");

    process.env.NEXT_PUBLIC_CHAIN = "foundry";
    expect(rpcUrl()).toBe("http://127.0.0.1:8545");
  });
});

describe("deployment addresses per network", () => {
  it("prefers the active network's own addresses over the generic ones", () => {
    process.env.NEXT_PUBLIC_CHAIN = "mainnet";
    process.env.NEXT_PUBLIC_TRIALS_ADDRESS = TRIALS;
    process.env.NEXT_PUBLIC_ALLOY_ADDRESS = ALLOY;
    process.env.NEXT_PUBLIC_MAINNET_TRIALS_ADDRESS = MAINNET_TRIALS;
    process.env.NEXT_PUBLIC_MAINNET_ALLOY_ADDRESS = MAINNET_ALLOY;

    const dep = deployment();
    expect(dep.chainId).toBe(1);
    expect(dep.trials).toBe(MAINNET_TRIALS);
    expect(dep.alloy).toBe(MAINNET_ALLOY);
    expect(dep.configured).toBe(true);
  });

  it("falls back to the generic addresses when the network's own are unset", () => {
    process.env.NEXT_PUBLIC_CHAIN = "mainnet";
    process.env.NEXT_PUBLIC_TRIALS_ADDRESS = TRIALS;
    process.env.NEXT_PUBLIC_ALLOY_ADDRESS = ALLOY;

    const dep = deployment();
    expect(dep.trials).toBe(TRIALS);
    expect(dep.alloy).toBe(ALLOY);
  });

  it("keeps the other networks' overrides out of each other's builds", () => {
    // One machine can hold all three deployments' addresses side by side; a sepolia
    // build must never sign against the mainnet contracts sitting in the same env file.
    process.env.NEXT_PUBLIC_TRIALS_ADDRESS = TRIALS;
    process.env.NEXT_PUBLIC_ALLOY_ADDRESS = ALLOY;
    process.env.NEXT_PUBLIC_MAINNET_TRIALS_ADDRESS = MAINNET_TRIALS;
    process.env.NEXT_PUBLIC_MAINNET_ALLOY_ADDRESS = MAINNET_ALLOY;

    process.env.NEXT_PUBLIC_CHAIN = "sepolia";
    expect(deployment().trials).toBe(TRIALS);

    process.env.NEXT_PUBLIC_CHAIN = "mainnet";
    expect(deployment().trials).toBe(MAINNET_TRIALS);
  });

  it("degrades a missing deployment to read-only, on every network", () => {
    for (const chain of ["mainnet", "sepolia", "foundry"] as const) {
      process.env.NEXT_PUBLIC_CHAIN = chain;
      const dep = deployment();
      expect(dep.trials).toBe(ZERO_ADDRESS);
      expect(dep.configured).toBe(false);
    }
  });
});

describe("wallet registration", () => {
  it("registers all three networks with the wallet, so the user can choose from it", () => {
    // The network is chosen by the wallet now. A config that ships one chain per build
    // would make that sentence false — the wallet would have nothing to switch to.
    const config = buildConfig();
    const ids = config.chains.map((c) => c.id).sort((a, b) => a - b);
    expect(ids).toEqual([1, 31337, 11155111]);
  });
});

describe("chainLabel", () => {
  it("names every network a wallet can be stranded on", () => {
    expect(chainLabel(CHAIN_IDS.mainnet)).toBe("Ethereum Mainnet");
    expect(chainLabel(CHAIN_IDS.sepolia)).toBe("Sepolia");
    expect(chainLabel(CHAIN_IDS.foundry)).toBe("Anvil");
    expect(chainLabel(999)).toBe("chain 999");
  });
});

describe("deployment for a live chain id (the wallet's, not the build's)", () => {
  beforeEach(() => {
    // One env file, three deployments side by side — the runtime-selection scenario.
    process.env.NEXT_PUBLIC_TRIALS_ADDRESS = TRIALS;
    process.env.NEXT_PUBLIC_ALLOY_ADDRESS = ALLOY;
    process.env.NEXT_PUBLIC_MAINNET_TRIALS_ADDRESS = MAINNET_TRIALS;
    process.env.NEXT_PUBLIC_MAINNET_ALLOY_ADDRESS = MAINNET_ALLOY;
  });

  it("resolves contracts from the connected wallet's chain id", () => {
    expect(deployment(1).trials).toBe(MAINNET_TRIALS);
    expect(deployment(11155111).trials).toBe(TRIALS);
    expect(deployment(31337).trials).toBe(TRIALS);
  });

  it("resolves an unknown chain to an unconfigured deployment with its own id", () => {
    // The one failure mode worse than a broken page is a page that works against the
    // WRONG contracts: a wallet on Base must never be handed Sepolia's addresses.
    const dep = deployment(8453);
    expect(dep.chainId).toBe(8453);
    expect(dep.trials).toBe(ZERO_ADDRESS);
    expect(dep.configured).toBe(false);
    expect(chainConfigured(8453)).toBe(false);
  });

  it("without an argument, resolves the build's default network (the disconnected spectator)", () => {
    process.env.NEXT_PUBLIC_CHAIN = "mainnet";
    expect(deployment().chainId).toBe(1);
    expect(deployment().trials).toBe(MAINNET_TRIALS);
  });

  it("chainFromId names the wallet's network, or null for a stranger", () => {
    expect(chainFromId(1)).toBe("mainnet");
    expect(chainFromId(11155111)).toBe("sepolia");
    expect(chainFromId(31337)).toBe("foundry");
    expect(chainFromId(8453)).toBeNull();
  });

  it("the badge can be asked about a network other than the build default", () => {
    process.env.NEXT_PUBLIC_CHAIN = "sepolia";
    expect(environmentBadge("mainnet").label).toBe("MAINNET");
    expect(environmentBadge("foundry").label).toBe("LOCAL FORGE");
  });
});
