// SPDX-License-Identifier: UNLICENSED
/**
 * Gate 750 — HuggingFace dataset connector.
 *
 * Reads datasets from the Hugging Face Hub (https://huggingface.co/api/datasets/{name})
 * and normalizes them into canonical batches. Never touches scoring logic.
 *
 * Uses an injectable fetch client so the connector is unit-testable without
 * hitting the network.
 */

import type { CanonicalRow, ModalityType } from "../canonical.js";
import type {
  Connector,
  ConnectorConfig,
  ConnectorResult,
  DatasetRef,
} from "./base.js";
import { ConnectorError } from "./base.js";

export interface HfFile {
  rfilename: string;
  size: number;
  type: string;
  path: string;
  url: string;
}

export interface HfDatasetInfo {
  id: string;
  siblings: HfFile[];
  cardData?: Record<string, unknown>;
}

/** HuggingFace connector configuration. */
export interface HfConfig extends ConnectorConfig {
  /** HF dataset name, e.g. "glue", "squad", "imdb". */
  dataset: string;
  /** Optional revision/branch. Default "main". */
  revision?: string;
  /** Optional subfolder within the dataset repo. */
  subfolder?: string;
}

export class HuggingFaceConnector implements Connector {
  readonly name = "huggingface";
  readonly version = "0.1.0";

  private httpFetch: (input: string | URL, init?: RequestInit) => Promise<Response>;
  private config?: HfConfig;

  constructor(
    httpFetchImpl?: (input: string | URL, init?: RequestInit) => Promise<Response>,
  ) {
    this.httpFetch = httpFetchImpl ?? ((input, init) => fetch(input, init));
  }

  async connect(config: ConnectorConfig): Promise<void> {
    if (!("dataset" in config)) {
      throw new ConnectorError("huggingface", "connect", "huggingface connector requires a dataset name", config);
    }
    this.config = config as HfConfig;
  }

  async list(): Promise<DatasetRef[]> {
    if (!this.config) throw new ConnectorError("huggingface", "list", "not connected");
    const { dataset, revision } = this.config;
    const url = `https://huggingface.co/api/datasets/${dataset}${revision ? `?revision=${revision}` : ""}`;
    let info: HfDatasetInfo;
    try {
      const res = await this.httpFetch(url);
      if (!res.ok) throw new Error(`HF API returned ${res.status}`);
      info = (await res.json()) as HfDatasetInfo;
    } catch (err) {
      throw new ConnectorError("huggingface", dataset, "failed to list dataset files", err);
    }
    return info.siblings.map((f) => ({
      source: this.name,
      identifier: f.rfilename,
      options: { revision, subfolder: this.config!.subfolder },
    }));
  }

  async fetch(ref: DatasetRef): Promise<ConnectorResult> {
    if (!this.config) throw new ConnectorError("huggingface", ref.identifier, "not connected");
    const { dataset, revision, subfolder } = this.config;
    const path = subfolder ? `${subfolder}/${ref.identifier}` : ref.identifier;
    const url = `https://huggingface.co/datasets/${dataset}/resolve/${revision ?? "main"}/${path}`;
    let bytes: Uint8Array;
    try {
      const res = await this.httpFetch(url);
      if (!res.ok) throw new Error(`HF resolve returned ${res.status}`);
      const ab = await res.arrayBuffer();
      bytes = new Uint8Array(ab);
    } catch (err) {
      throw new ConnectorError("huggingface", ref.identifier, "failed to download file", err);
    }

    const file: ManualFile = { name: ref.identifier, bytes, mimeType: undefined };
    // Reuse the manual file parser.
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
