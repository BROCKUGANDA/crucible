/**
 * Reading the bytes a trial's digest commits to.
 *
 * The chain holds a keccak digest; the disclosure log names the sha256 CID for the same bytes;
 * the content store holds those bytes. The first two links were published and the third was
 * reachable only by whoever pinned the files, so a reader could check that a trial committed to
 * *something* but could not read what. That is the gap this closes: the page that shows
 * `suite bafy…` can now hand the reader the suite.
 *
 * Three states are kept apart because they mean different things to different people:
 *
 *   "not-pinned"  — this host's store has no such entry. The bytes exist; they are not here.
 *   "unresolved"  — a digest was asked for and no CID is published for it on this host. Nothing
 *                   was announced, which is a statement about the disclosure log, not the chain.
 *   "unreadable"  — the store could not be opened at all. An operational fault, and the route
 *                   answers 503 so nobody reads it as "this trial has no suite".
 *
 * A CID is content-addressed and the store re-hashes on every read, so a served entry is proved
 * to be the bytes that id names. A damaged entry is reported as corrupt rather than missing,
 * because "absent" and "present but wrong" need different repairs.
 */

import { readFileSync } from "node:fs";
import { CidStore, ContentCorruptedError, isCid } from "@crucible/cidstore";

export type ContentRead =
  | { kind: "text"; text: string }
  | { kind: "bytes"; bytes: Uint8Array }
  | { kind: "not-pinned" }
  | { kind: "unresolved"; reason: string }
  | { kind: "unreadable"; reason: string }
  | { kind: "corrupt"; reason: string };

export type ContentLookup = (id: string) => ContentRead;

const DIGEST = /^0x[0-9a-fA-F]{64}$/;

/** Reads UTF-8 strictly; anything that fails the decoder is handed back as bytes. */
function decode(bytes: Uint8Array): ContentRead {
  try {
    return { kind: "text", text: new TextDecoder("utf-8", { fatal: true }).decode(bytes) };
  } catch {
    return { kind: "bytes", bytes };
  }
}

/**
 * A lookup over one content directory plus the digest→CID map published beside it.
 *
 * `readDisclosure` is injected rather than imported so a test can hand this a map without a
 * filesystem, and the caller owns the file's error reporting (see `disclosure.ts`, which already
 * distinguishes "no file" from "unreadable file").
 */
export function createContentSource(
  contentDir: string,
  readDisclosure: () => Map<string, string>,
): ContentLookup {
  let store: CidStore | null = null;
  let storeFault: string | null = null;

  function open(): CidStore | null {
    if (store !== null) return store;
    if (storeFault !== null) return null;
    try {
      store = new CidStore({ dir: contentDir });
      return store;
    } catch (err) {
      storeFault = err instanceof Error ? err.message : String(err);
      return null;
    }
  }

  return (id: string): ContentRead => {
    let target = id;

    if (DIGEST.test(id)) {
      const resolved = readDisclosure().get(id.toLowerCase()) ?? null;
      if (resolved === null) {
        return {
          kind: "unresolved",
          reason: "No CID is published on this host for that digest",
        };
      }
      target = resolved;
    }

    if (!isCid(target)) {
      return {
        kind: "unresolved",
        reason: "Not a CID and not a 32-byte digest",
      };
    }

    const box = open();
    if (box === null) {
      return { kind: "unreadable", reason: `${contentDir}: ${storeFault ?? "could not be opened"}` };
    }

    try {
      const bytes = box.getBytes(target);
      if (bytes === null) return { kind: "not-pinned" };
      return decode(bytes);
    } catch (err) {
      if (err instanceof ContentCorruptedError) return { kind: "corrupt", reason: err.message };
      return { kind: "unreadable", reason: err instanceof Error ? err.message : String(err) };
    }
  };
}

/**
 * The digest→CID map, lowercased.
 *
 * Separate from `disclosedCids` because that one answers "which CIDs does this trial have" for
 * the snapshot, and this answers "whose bytes is this CID" for a read that arrived with only the
 * digest. Both parse the same file, so the file name lives in one place.
 */
export function digestToCidMap(file: string, onFault: (message: string) => void): Map<string, string> {
  const map = new Map<string, string>();
  let parsed: { specs?: Record<string, unknown> };
  try {
    parsed = JSON.parse(readFileSync(file, "utf8")) as { specs?: Record<string, unknown> };
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
      onFault(`${file}: ${err instanceof Error ? err.message : String(err)}`);
    }
    return map;
  }
  for (const [digest, cid] of Object.entries(parsed.specs ?? {})) {
    if (typeof cid === "string") map.set(digest.toLowerCase(), cid);
  }
  return map;
}
