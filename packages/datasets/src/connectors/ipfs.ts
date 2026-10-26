// SPDX-License-Identifier: UNLICENSED
/**
 * Gate 750 — IPFS dataset connector.
 *
 * Reads datasets from IPFS via an HTTP gateway (content-addressed by CID).
 * Injects the fetch client for testability. Never touches scoring logic.
 */

import type { CanonicalRow, ModalityType } from "../canonical.js";
import type {
  Connector,
  ConnectorConfig,
  ConnectorResult,
  DatasetRef,
} from "./base.js";
import { ConnectorError } from "./base.js";

/** IPFS connector configuration. */
export interface IpfsConfig extends ConnectorConfig {
  /** Gateway URL, e.g. "https://ipfs.io/ipfs" or "https://gateway.ipfs.io". */
  gateway: string;
}

export class IpfsConnector implements Connector {
  readonly name = "ipfs";
  readonly version = "0.1.0";

  private httpFetch: (input: string | URL, init?: RequestInit) => Promise<Response>;
  private config?: IpfsConfig;

  constructor(
    httpFetchImpl?: (input: string | URL, init?: RequestInit) => Promise<Response>,
  ) {
    this.httpFetch = httpFetchImpl ?? ((input, init) => fetch(input, init));
  }

  async connect(config: ConnectorConfig): Promise<void> {
    if (!("gateway" in config)) {
      throw new ConnectorError("ipfs", "connect", "IPFS connector requires a gateway URL", config);
    }
    this.config = config as IpfsConfig;
  }

  async list(): Promise<DatasetRef[]> {
    // IPFS has no global "list" operation without knowing the CID first.
    // Return empty; callers must know the identifier (CID) to fetch.
    return [];
  }

  async fetch(ref: DatasetRef): Promise<ConnectorResult> {
    if (!this.config) throw new ConnectorError("ipfs", ref.identifier, "not connected");
    const { gateway } = this.config;
    const url = `${gateway.replace(/\/$/, "")}/${ref.identifier}`;
    let bytes: Uint8Array;
    try {
      const res = await this.httpFetch(url);
      if (!res.ok) throw new Error(`IPFS gateway returned ${res.status}`);
      const ab = await res.arrayBuffer();
      bytes = new Uint8Array(ab);
    } catch (err) {
      throw new ConnectorError("ipfs", ref.identifier, "failed to fetch from gateway", err);
    }

    const file: ManualFile = { name: ref.identifier, bytes, mimeType: undefined };
    const { parseFile } = await import("./manual.js");
    const batch = parseFile(file, ref);
    return { ref, batch };
  }

  async disconnect(): Promise<void> {
    this.config = undefined;
  }
}

/** Minimal file shape for reuse by the manual parser. */
interface ManualFile {
  name: string;
  bytes: Uint8Array;
  mimeType?: string;
}
