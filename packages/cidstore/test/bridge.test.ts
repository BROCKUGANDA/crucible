import { createHash } from "node:crypto";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { CidStore } from "../src/store.js";
import { DisclosureLog } from "../src/disclosure.js";
import { ContentBridge, ContentUnverifiable } from "../src/bridge.js";
import type { Content } from "../src/cid.js";

/**
 * The gate in front of the two digests a chain commits to.
 *
 * `pinContent` announces a mapping from a digest to a CID, and the digest is what goes on-chain as a
 * trial's spec or tests commitment. So the only question this file asks is whether an announcement
 * can ever name content the store does not actually hold — because the reader that follows such an
 * announcement reports "no content behind this commitment" about bytes the pinning process believes
 * it stored, and a verifier that abstains for the wrong reason is worse than one that never ran: it
 * looks like a judgement.
 *
 * The digest here is sha256 rather than keccak on purpose. `digestOf` is injected, and the property
 * under test is the bridge refusing to announce two values that disagree — which hash reconciles
 * them is a separate concern, already covered by the roundtrip script.
 */
const digestOf = (content: string | Uint8Array) =>
  `0x${createHash("sha256").update(typeof content === "string" ? new TextEncoder().encode(content) : content).digest("hex")}`;

async function fixture() {
  const dir = await mkdtemp(path.join(tmpdir(), "crucible-bridge-"));
  const store = CidStore.inMemory();
  const disclosure = await DisclosureLog.open(dir);
  const file = path.join(dir, "disclosure.json");
  const bridge = new ContentBridge({ store, disclosure, digestOf });
  /** The same log, in front of a different store — so a write that leaks is impossible to miss. */
  const withStore = (broken: unknown) => new ContentBridge({ store: broken as CidStore, disclosure, digestOf });
  return { store, disclosure, bridge, file, dir, withStore };
}

/**
 * What the log on disk actually claims — the end state, not the return value.
 *
 * A log that never announced has no file at all: `flush` only runs on an announcement. So a missing
 * file is read as the empty map rather than an error, which is also the strongest available answer
 * to "did the refused pin leak a pointer?" — it did not, there is nothing there.
 */
async function announced(file: string): Promise<Record<string, string>> {
  let raw: string;
  try {
    raw = await readFile(file, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw err;
  }
  const parsed = JSON.parse(raw) as { specs?: Record<string, string> };
  return parsed.specs ?? {};
}

describe("ContentBridge.pinContent", () => {
  it("announces the digest the bytes actually answer to", async () => {
    const { bridge, file } = await fixture();
    const spec = "contract Counter { function inc() external {} }";

    const pinned = await bridge.pinContent(spec);

    expect(pinned.digest).toBe(digestOf(spec));
    expect(pinned.bytes).toBe(new TextEncoder().encode(spec).byteLength);
    expect(await announced(file)).toEqual({ [pinned.digest]: pinned.cid });
  });

  it("refuses to announce a digest whose bytes the store cannot hand back", async () => {
    const { store, file, withStore } = await fixture();

    // The store took the write and then cannot read it — a partial flush, an eviction race, a
    // backend that filed it under a different key. Before this check, every one of those was a
    // silent success that went straight into the on-chain commitment.
    const lost = {
      put: (c: Content) => store.put(c),
      putJson: (v: unknown) => store.putJson(v),
      get: () => null,
      getBytes: () => null,
    };
    await expect(withStore(lost).pinContent("lost suite text")).rejects.toBeInstanceOf(ContentUnverifiable);

    // The property that matters: the log is still empty. A refusal that announced first would leave
    // the chain free to commit to a digest pointing at nothing.
    expect(await announced(file)).toEqual({});
  });

  it("refuses when the bytes that come back hash to something else", async () => {
    const { store, file, withStore } = await fixture();
    const written = "spec: increments a counter";
    const mutated = "spec: increments a counter, and drains the vault";

    // Content filed under a CID that is not its content: the write succeeds, the read succeeds, and
    // only the digest comparison catches it. Presence alone would pass — which is what the artifact
    // path already checks and this path used not to.
    const swapped = {
      put: (c: Content) => store.put(c),
      putJson: (v: unknown) => store.putJson(v),
      get: () => mutated,
      getBytes: () => new TextEncoder().encode(mutated),
    };
    await expect(withStore(swapped).pinContent(written)).rejects.toBeInstanceOf(ContentUnverifiable);
    expect(await announced(file)).toEqual({});
  });

  it("counts the bytes it pinned, not the characters it was handed", async () => {
    const { bridge } = await fixture();
    const nonAscii = "spec: рayрal is not paypal";

    const pinned = await bridge.pinContent(nonAscii);

    expect(pinned.bytes).toBe(new TextEncoder().encode(nonAscii).byteLength);
    expect(pinned.bytes).toBeGreaterThan(nonAscii.length);
  });
});
