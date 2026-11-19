import { afterEach, describe, expect, it, vi } from "vitest";
import { sepolia } from "wagmi/chains";
import {
  createWeb3AuthConnector,
  web3AuthClientId,
  web3AuthConnector,
  web3AuthEnabled,
} from "../src/lib/web3auth-connector";
import { buildConfig, rainbowWalletGroups, web3AuthRainbowWallet } from "../src/lib/wagmi";

const OWNER = "0x1111111111111111111111111111111111111111";

afterEach(() => vi.unstubAllEnvs());

function makeConnector() {
  let chainId = "0xaa36a7";
  let connection: { ethereumProvider?: unknown } | null = null;
  const listeners = new Map<string, (...args: unknown[]) => void>();
  const provider = {
    request: vi.fn(async (args: { method: string; params?: readonly unknown[] | object }) => {
      if (args.method === "eth_accounts") return [OWNER, "not-an-address"];
      if (args.method === "eth_chainId") return chainId;
      if (args.method === "wallet_switchEthereumChain") {
        const parameters = args.params as readonly { chainId: string }[];
        chainId = parameters[0]!.chainId;
        return null;
      }
      throw new Error(`Unexpected provider method: ${args.method}`);
    }),
    on: vi.fn((event: string, listener: (...args: unknown[]) => void) => listeners.set(event, listener)),
    removeListener: vi.fn((event: string, listener: (...args: unknown[]) => void) => {
      if (listeners.get(event) === listener) listeners.delete(event);
    }),
  };
  const client = {
    init: vi.fn(async () => undefined),
    connect: vi.fn(async () => {
      connection = { ethereumProvider: provider };
      return connection;
    }),
    logout: vi.fn(async () => {
      connection = null;
    }),
    get connection() {
      return connection;
    },
  };
  const createClient = vi.fn(async () => client as never);
  const emit = vi.fn();
  const connector = createWeb3AuthConnector("public-client-id", createClient)({
    chains: [sepolia],
    emitter: { emit },
  } as never);

  return { connector, client, createClient, provider, listeners, emit };
}

describe("optional Web3Auth configuration", () => {
  it("keeps Web3Auth out of the wallet lists when no public client id is set", () => {
    vi.stubEnv("NEXT_PUBLIC_WEB3AUTH_CLIENT_ID", " ");
    vi.stubEnv("NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID", "");

    expect(web3AuthEnabled()).toBe(false);
    expect(web3AuthClientId()).toBe("");
    expect(() => web3AuthConnector()).toThrow("Set NEXT_PUBLIC_WEB3AUTH_CLIENT_ID");
    expect(buildConfig().connectors.some((connector) => connector.id === "web3auth")).toBe(false);
    expect(rainbowWalletGroups()[0]!.wallets).not.toContain(web3AuthRainbowWallet);
  });

  it("registers the EOA connector in Wagmi and RainbowKit when configured", () => {
    vi.stubEnv("NEXT_PUBLIC_WEB3AUTH_CLIENT_ID", " public-client-id ");
    vi.stubEnv("NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID", "");

    expect(web3AuthEnabled()).toBe(true);
    expect(web3AuthClientId()).toBe("public-client-id");
    expect(buildConfig().connectors.some((connector) => connector.id === "web3auth")).toBe(true);
    expect(rainbowWalletGroups()[0]!.wallets).toContain(web3AuthRainbowWallet);
    expect(web3AuthRainbowWallet().id).toBe("web3auth");
  });
});

describe("Web3Auth Wagmi connector", () => {
  it("restores authorization without opening login and connects an EVM account on demand", async () => {
    const { connector, client, createClient } = makeConnector();

    await connector.setup?.();
    expect(await connector.isAuthorized()).toBe(false);
    expect(client.connect).not.toHaveBeenCalled();

    const result = await connector.connect();
    expect(createClient).toHaveBeenCalledExactlyOnceWith("public-client-id");
    expect(client.connect).toHaveBeenCalledOnce();
    expect(result.accounts).toEqual([OWNER]);
    expect(result.chainId).toBe(11155111);
    expect(await connector.isAuthorized()).toBe(true);
  });

  it("normalizes provider events and removes listeners on logout", async () => {
    const { connector, provider, listeners, emit, client } = makeConnector();
    await connector.connect();

    listeners.get("chainChanged")?.("0x1");
    expect(emit).toHaveBeenCalledWith("change", { chainId: 1 });
    listeners.get("chainChanged")?.("not-a-chain-id");
    expect(emit).toHaveBeenCalledWith("error", {
      error: expect.objectContaining({ message: "Web3Auth returned an invalid EVM chain id." }),
    });

    listeners.get("accountsChanged")?.([OWNER]);
    expect(emit).toHaveBeenCalledWith("change", { accounts: [OWNER] });

    await connector.disconnect();
    expect(client.logout).toHaveBeenCalledOnce();
    expect(provider.removeListener).toHaveBeenCalledTimes(3);
    expect(listeners.size).toBe(0);
    expect(emit).toHaveBeenCalledWith("disconnect");
    expect(provider.request.mock.calls.every(([args]) => args.method !== "private_key")).toBe(true);
  });

  it("switches only to a chain registered with the Crucible connector", async () => {
    const { connector, provider } = makeConnector();
    await connector.connect();
    const switchChain = connector.switchChain;
    if (!switchChain) throw new Error("Web3Auth connector omitted switchChain.");

    await expect(switchChain({ chainId: sepolia.id })).resolves.toMatchObject({ id: sepolia.id });
    expect(provider.request).toHaveBeenCalledWith({
      method: "wallet_switchEthereumChain",
      params: [{ chainId: "0xaa36a7" }],
    });
    await expect(switchChain({ chainId: 1 })).rejects.toThrow("not configured in Crucible");
  });

  it("disconnects if the provider reports that the active account list became empty", async () => {
    const { connector, listeners, emit } = makeConnector();
    await connector.connect();

    listeners.get("accountsChanged")?.([]);
    expect(emit).toHaveBeenCalledWith("disconnect");
    expect(listeners.size).toBe(0);
  });

  it("rejects an empty EVM session rather than treating it as an account", async () => {
    const { connector, provider } = makeConnector();
    provider.request.mockImplementation(async ({ method }) => (method === "eth_accounts" ? [] : "0xaa36a7"));

    await expect(connector.connect()).rejects.toThrow("returned no connected EVM account");
  });

  it("rejects a malformed chain id returned by the connected provider", async () => {
    const { connector, provider } = makeConnector();
    provider.request.mockImplementation(async ({ method }) => (method === "eth_accounts" ? [OWNER] : "invalid"));

    await expect(connector.connect()).rejects.toThrow("invalid EVM chain id");
  });
});