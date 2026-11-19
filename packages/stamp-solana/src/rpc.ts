/**
 * @file rpc.ts — the only way this package learns anything about the chain.
 *
 * Every read is a `getAccountInfo` or a `getSignatureStatuses` against a named
 * endpoint. There is no write path and no key: this process can observe the
 * chain and cannot act on it. That is a product decision (ADR-0006's "the API
 * holds no chain key") applied to a new domain, and it is enforced here by the
 * absence of anything that signs.
 *
 * The transport is injected. Tests supply a deterministic fake and the
 * production path supplies `fetch`; nothing in the verification logic knows
 * which one it is talking to, so the verifier can be exercised without a
 * validator.
 */

export type Commitment = "processed" | "confirmed" | "finalized";

export interface SolanaAccountInfo {
  /** Base64 account data, as the RPC returns it. */
  dataBase64: string;
  /** The account's owner program. */
  owner: string;
  /** Lamports in the account. */
  lamports: number;
  executable: boolean;
  /** The slot the account was last written in, when the RPC reports it. */
  slot?: number;
}

export interface SignatureStatus {
  /** `null` while the signature is unknown to the node. */
  status: "processed" | "confirmed" | "finalized" | null;
  err: unknown | null;
  slot: number | null;
  /** True when the node says the transaction is still roll-backable. */
  confirmations: number | null;
}

export interface SolanaRpc {
  /** The endpoint's cluster name, for reporting. */
  cluster(): string;
  getGenesisHash(): Promise<string>;
  getSlot(commitment: Commitment): Promise<number>;
  getAccountInfo(address: string, commitment: Commitment): Promise<SolanaAccountInfo | null>;
  getSignatureStatuses(signatures: readonly string[]): Promise<(SignatureStatus | null)[]>;
  getTokenSupply(mint: string): Promise<{ amount: string; decimals: number }>;
}

export interface RpcEndpointConfig {
  /** The JSON-RPC URL. A secret-free URL: the API holds no authenticated key. */
  url: string;
  /** The cluster this endpoint is expected to serve. */
  cluster: string;
  /** An injected transport, for tests. Defaults to global `fetch`. */
  fetchImpl?: typeof fetch;
  /** Per-request timeout, in milliseconds. */
  timeoutMs?: number;
}

export class RpcError extends Error {
  constructor(
    message: string,
    readonly method: string,
    readonly detail?: unknown,
  ) {
    super(message);
    this.name = "RpcError";
  }
}

/** A JSON-RPC client over `fetch`. Read-only by construction. */
export class HttpSolanaRpc implements SolanaRpc {
  private readonly url: string;
  private readonly clusterName: string;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;

  constructor(config: RpcEndpointConfig) {
    this.url = config.url;
    this.clusterName = config.cluster;
    this.fetchImpl = config.fetchImpl ?? globalThis.fetch;
    this.timeoutMs = config.timeoutMs ?? 10_000;
  }

  cluster(): string {
    return this.clusterName;
  }

  async call<T>(method: string, params: unknown[]): Promise<T> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    let response: Response;
    try {
      response = await this.fetchImpl(this.url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
        signal: controller.signal,
      });
    } catch (error) {
      throw new RpcError(`rpc ${method} transport failed`, method, error);
    } finally {
      clearTimeout(timer);
    }
    if (!response.ok) {
      throw new RpcError(`rpc ${method} answered HTTP ${response.status}`, method, response.status);
    }
    const body = (await response.json()) as { result?: T; error?: { message?: string; code?: number } };
    if (body.error) {
      throw new RpcError(`rpc ${method} failed: ${body.error.message ?? "unknown"}`, method, body.error);
    }
    if (body.result === undefined) {
      throw new RpcError(`rpc ${method} returned no result`, method, body);
    }
    return body.result;
  }

  async getGenesisHash(): Promise<string> {
    return this.call<string>("getGenesisHash", []);
  }

  async getSlot(commitment: Commitment): Promise<number> {
    return this.call<number>("getSlot", [{ commitment }]);
  }

  async getAccountInfo(address: string, commitment: Commitment): Promise<SolanaAccountInfo | null> {
    const result = await this.call<{
      value: { data: [string, string]; owner: string; lamports: number; executable: boolean; slot?: number } | null;
    }>("getAccountInfo", [address, { encoding: "base64", commitment }]);
    if (!result.value) return null;
    return {
      dataBase64: result.value.data[0],
      owner: result.value.owner,
      lamports: result.value.lamports,
      executable: result.value.executable,
      slot: result.value.slot,
    };
  }

  async getSignatureStatuses(signatures: readonly string[]): Promise<(SignatureStatus | null)[]> {
    const result = await this.call<{
      value: ({ slot: number; err: unknown; confirmations: number | null; confirmationStatus?: string } | null)[];
    }>("getSignatureStatuses", [signatures, { searchTransactionHistory: true }]);
    return result.value.map((entry) => {
      if (!entry) return null;
      return {
        status: (entry.confirmationStatus ?? "processed") as SignatureStatus["status"],
        err: entry.err,
        slot: entry.slot,
        confirmations: entry.confirmations,
      };
    });
  }

  async getTokenSupply(mint: string): Promise<{ amount: string; decimals: number }> {
    const result = await this.call<{ value: { amount: string; decimals: number } }>("getTokenSupply", [
      mint,
      { commitment: "finalized" },
    ]);
    return result.value;
  }
}