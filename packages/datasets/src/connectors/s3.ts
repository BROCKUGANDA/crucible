// SPDX-License-Identifier: UNLICENSED
/**
 * Gate 750 — S3 dataset connector.
 *
 * Reads datasets from an S3-compatible bucket (AWS S3, MinIO, etc.) via an
 * injectable fetch client. Lists objects under a prefix and downloads them
 * into canonical batches. Never touches scoring logic.
 */

import type { CanonicalRow, ModalityType } from "../canonical.js";
import type {
  Connector,
  ConnectorConfig,
  ConnectorResult,
  DatasetRef,
} from "./base.js";
import { ConnectorError } from "./base.js";

export interface S3Object {
  Key: string;
  Size: number;
  LastModified: string;
}

export interface S3ListResponse {
  Contents?: S3Object[];
  Name?: string;
}

/** S3 connector configuration. */
export interface S3Config extends ConnectorConfig {
  bucket: string;
  region?: string;
  prefix?: string;
  endpoint?: string; // for MinIO or other S3-compatible endpoints
}

export class S3Connector implements Connector {
  readonly name = "s3";
  readonly version = "0.1.0";

  private httpFetch: (input: string | URL, init?: RequestInit) => Promise<Response>;
  private config?: S3Config;

  constructor(
    httpFetchImpl?: (input: string | URL, init?: RequestInit) => Promise<Response>,
  ) {
    this.httpFetch = httpFetchImpl ?? ((input, init) => fetch(input, init));
  }

  async connect(config: ConnectorConfig): Promise<void> {
    if (!("bucket" in config)) {
      throw new ConnectorError("s3", "connect", "S3 connector requires a bucket name", config);
    }
    this.config = config as S3Config;
  }

  async list(): Promise<DatasetRef[]> {
    if (!this.config) throw new ConnectorError("s3", "list", "not connected");
    const { bucket, region, prefix, endpoint } = this.config;
    const base = endpoint ?? `https://${bucket}.s3.${region ?? "us-east-1"}.amazonaws.com`;
    const query = prefix ? `?prefix=${encodeURIComponent(prefix)}&list-type=2` : "?list-type=2";
    const url = `${base}${query}`;
    let list: S3ListResponse;
    try {
      const res = await this.httpFetch(url);
      if (!res.ok) throw new Error(`S3 ListObjects returned ${res.status}`);
      const text = await res.text();
      // S3 returns XML; do a minimal parse without external deps.
      list = parseS3ListXml(text);
    } catch (err) {
      throw new ConnectorError("s3", bucket, "failed to list bucket objects", err);
    }
    const keys = (list.Contents ?? [])
      .map((o) => o.Key)
      .filter((k) => k && !k.endsWith("/"));
    return keys.map((key) => ({
      source: this.name,
      identifier: key,
      options: { bucket, region, endpoint },
    }));
  }

  async fetch(ref: DatasetRef): Promise<ConnectorResult> {
    if (!this.config) throw new ConnectorError("s3", ref.identifier, "not connected");
    const { bucket, region, endpoint } = this.config;
    const base = endpoint ?? `https://${bucket}.s3.${region ?? "us-east-1"}.amazonaws.com`;
    const url = `${base}/${encodeURIComponent(ref.identifier)}`;
    let bytes: Uint8Array;
    try {
      const res = await this.httpFetch(url);
      if (!res.ok) throw new Error(`S3 GetObject returned ${res.status}`);
      const ab = await res.arrayBuffer();
      bytes = new Uint8Array(ab);
    } catch (err) {
      throw new ConnectorError("s3", ref.identifier, "failed to download object", err);
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

/** Very small S3 ListObjectsV2 XML parser (no external deps). */
function parseS3ListXml(xml: string): S3ListResponse {
  const contents: S3Object[] = [];
  const keyMatches = xml.matchAll(/<Key>([^<]*)<\/Key>/g);
  const sizeMatches = xml.matchAll(/<Size>(\d+)<\/Size>/g);
  const dateMatches = xml.matchAll(/<LastModified>([^<]*)<\/LastModified>/g);
  const keys = [...keyMatches].map((m) => m[1]);
  const sizes = [...sizeMatches].map((m) => Number(m[1]));
  const dates = [...dateMatches].map((m) => m[1]);
  for (let i = 0; i < keys.length; i++) {
    contents.push({
      Key: keys[i] ?? "",
      Size: sizes[i] ?? 0,
      LastModified: dates[i] ?? "",
    });
  }
  return { Contents: contents };
}
