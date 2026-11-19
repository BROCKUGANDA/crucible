import { getAddress, isAddress, type Address } from "viem";
import { createConnector } from "wagmi";

type EvmProvider = {
  request(args: { readonly method: string; readonly params?: readonly unknown[] | object }): Promise<unknown>;
  on?: (event: string, listener: (...args: unknown[]) => void) => void;
  removeListener?: (event: string, listener: (...args: unknown[]) => void) => void;
};

type Web3AuthConnection = { ethereumProvider?: unknown | null } | null | undefined;

type Web3AuthClient = {
  init(): Promise<void>;
  connect(): Promise<Web3AuthConnection>;
  logout(): Promise<void>;
  connection?: Web3AuthConnection;
};

export type Web3AuthClientFactory = (clientId: string) => Promise<Web3AuthClient>;

export function web3AuthClientId(): string {
  return process.env.NEXT_PUBLIC_WEB3AUTH_CLIENT_ID?.trim() ?? "";
}

export function web3AuthEnabled(): boolean {
  return web3AuthClientId().length > 0;
}

async function loadWeb3AuthClient(clientId: string): Promise<Web3AuthClient> {
  const { Web3Auth, WEB3AUTH_NETWORK } = await import("@web3auth/modal");
  const client = new Web3Auth({
    clientId,
    web3AuthNetwork: WEB3AUTH_NETWORK.SAPPHIRE_MAINNET,
  });
  await client.init();
  return client as unknown as Web3AuthClient;
}

function evmProvider(connection: Web3AuthConnection): EvmProvider | undefined {
  const candidate = connection?.ethereumProvider;
  if (!candidate || typeof candidate !== "object") return undefined;
  const request = (candidate as { request?: unknown }).request;
  return typeof request === "function" ? (candidate as EvmProvider) : undefined;
}

function parseAccounts(value: unknown): readonly Address[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((account): Address[] => {
    if (typeof account !== "string" || !isAddress(account)) return [];
    try {
      return [getAddress(account)];
    } catch {
      return [];
    }
  });
}

function parseChainId(value: unknown): number {
  if (typeof value !== "string" || !/^0x[0-9a-f]+$/i.test(value)) {
    throw new Error("Web3Auth returned an invalid EVM chain id.");
  }
  const chainId = Number(BigInt(value));
  if (!Number.isSafeInteger(chainId) || chainId < 1) {
    throw new Error("Web3Auth returned an invalid EVM chain id.");
  }
  return chainId;
}

export function createWeb3AuthConnector(
  clientId: string,
  createClient: Web3AuthClientFactory = loadWeb3AuthClient,
) {
  const configuredClientId = clientId.trim();
  if (!configuredClientId) throw new Error("Set NEXT_PUBLIC_WEB3AUTH_CLIENT_ID to enable Web3Auth.");

  return createConnector<EvmProvider>((config) => {
    let clientPromise: Promise<Web3AuthClient> | undefined;
    let provider: EvmProvider | undefined;
    let providerListeners:
      | {
          provider: EvmProvider;
          accountsChanged: (...args: unknown[]) => void;
          chainChanged: (...args: unknown[]) => void;
          disconnected: (...args: unknown[]) => void;
        }
      | undefined;

    const getClient = () => {
      clientPromise ??= createClient(configuredClientId).catch((error: unknown) => {
        clientPromise = undefined;
        throw error;
      });
      return clientPromise;
    };

    const getProvider = async () => {
      if (provider) return provider;
      const client = await getClient();
      provider = evmProvider(client.connection);
      if (!provider) throw new Error("Connect an EVM account with Web3Auth first.");
      return provider;
    };

    const removeProviderListeners = () => {
      if (!providerListeners) return;
      providerListeners.provider.removeListener?.("accountsChanged", providerListeners.accountsChanged);
      providerListeners.provider.removeListener?.("chainChanged", providerListeners.chainChanged);
      providerListeners.provider.removeListener?.("disconnect", providerListeners.disconnected);
      providerListeners = undefined;
    };

    const handleDisconnect = () => {
      removeProviderListeners();
      provider = undefined;
      config.emitter.emit("disconnect");
    };

    const handleAccountsChanged = (value: unknown) => {
      const accounts = parseAccounts(value);
      if (accounts.length === 0) {
        handleDisconnect();
        return;
      }
      config.emitter.emit("change", { accounts });
    };

    const handleChainChanged = (value: unknown) => {
      try {
        config.emitter.emit("change", { chainId: parseChainId(value) });
      } catch {
        config.emitter.emit("error", { error: new Error("Web3Auth returned an invalid EVM chain id.") });
      }
    };

    const switchToChain = async (chainId: number) => {
      const chain = config.chains.find((candidate) => candidate.id === chainId);
      if (!chain) throw new Error(`Chain ${chainId} is not configured in Crucible.`);
      const connectedProvider = await getProvider();
      await connectedProvider.request({
        method: "wallet_switchEthereumChain",
        params: [{ chainId: `0x${chainId.toString(16)}` }],
      });
      return chain;
    };

    const addProviderListeners = (connectedProvider: EvmProvider) => {
      if (providerListeners?.provider === connectedProvider) return;
      removeProviderListeners();
      if (!connectedProvider.on) return;

      const accountsChanged = (accounts: unknown) => handleAccountsChanged(accounts);
      const chainChanged = (chainId: unknown) => handleChainChanged(chainId);
      const disconnected = () => handleDisconnect();
      providerListeners = { provider: connectedProvider, accountsChanged, chainChanged, disconnected };
      connectedProvider.on("accountsChanged", accountsChanged);
      connectedProvider.on("chainChanged", chainChanged);
      connectedProvider.on("disconnect", disconnected);
    };

    return {
      id: "web3auth",
      name: "Web3Auth",
      type: "web3auth",

      async setup() {
        try {
          const connectedProvider = await getProvider();
          addProviderListeners(connectedProvider);
        } catch {
          // Initialization restores a prior session without opening the login modal.
        }
      },

      async connect<withCapabilities extends boolean = false>(parameters?: {
        chainId?: number;
        isReconnecting?: boolean;
        withCapabilities?: withCapabilities | boolean;
      }) {
        const client = await getClient();
        let connectedProvider = evmProvider(client.connection);
        if (!connectedProvider) {
          const connection = await client.connect();
          connectedProvider = evmProvider(connection) ?? evmProvider(client.connection);
        }
        if (!connectedProvider) throw new Error("Web3Auth did not return an EVM account. Configure an EVM login method.");

        provider = connectedProvider;
        addProviderListeners(connectedProvider);

        if (parameters?.chainId !== undefined && parseChainId(await connectedProvider.request({ method: "eth_chainId" })) !== parameters.chainId) {
          await switchToChain(parameters.chainId);
        }

        const accounts = parseAccounts(await connectedProvider.request({ method: "eth_accounts" }));
        if (accounts.length === 0) throw new Error("Web3Auth returned no connected EVM account.");
        const chainId = parseChainId(await connectedProvider.request({ method: "eth_chainId" }));
        const connectedAccounts = parameters?.withCapabilities
          ? accounts.map((address) => ({ address, capabilities: {} }))
          : accounts;

        return {
          accounts: connectedAccounts as withCapabilities extends true
            ? readonly { address: Address; capabilities: Record<string, unknown> }[]
            : readonly Address[],
          chainId,
        };
      },

      async disconnect() {
        const client = await getClient();
        handleDisconnect();
        await client.logout();
      },

      async getAccounts() {
        const connectedProvider = await getProvider();
        return parseAccounts(await connectedProvider.request({ method: "eth_accounts" }));
      },

      async getChainId() {
        const connectedProvider = await getProvider();
        return parseChainId(await connectedProvider.request({ method: "eth_chainId" }));
      },

      async getProvider() {
        return getProvider();
      },

      async isAuthorized() {
        try {
          const accounts = await (await getProvider()).request({ method: "eth_accounts" });
          return parseAccounts(accounts).length > 0;
        } catch {
          return false;
        }
      },

      async switchChain({ chainId }) {
        return switchToChain(chainId);
      },

      onAccountsChanged(accounts) {
        handleAccountsChanged(accounts);
      },

      onChainChanged(chainId) {
        handleChainChanged(chainId);
      },

      onDisconnect() {
        handleDisconnect();
      },
    };
  });
}

export function web3AuthConnector() {
  return createWeb3AuthConnector(web3AuthClientId());
}