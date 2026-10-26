/**
 * Resolving an on-chain digest to the readable address of the bytes behind it.
 *
 * The chain holds only a keccak digest of a trial's spec and suite; the sha256 CID that names
 * the pinned files is published off-chain by whichever process pinned them, into
 * `<content dir>/disclosure/disclosure.json` (`DisclosureLog.open(join(dir, "disclosure"))`).
 * The API is a different container from every writer, so this module is the reader half of
 * that contract and the path shape is load-bearing: a reader looking one directory off, or
 * behind a misspelled variable name, reports "suite not disclosed yet" about a suite that was
 * disclosed hours ago — which is exactly what every trial row said before this file existed.
 *
 * An absent file is the honest empty answer: nothing has been announced. A malformed one is
 * an operational fault and is reported, because returning nothing quietly would restore the
 * same false "not disclosed" this reader exists to end.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";

export interface DisclosureEntry {
  trialId: number;
  specCID?: string;
  testsCID?: string;
}

/** The digest a trial committed to, and the id it was committed under. */
export interface TrialDigests {
  id: number;
  specDigest: string;
  testsDigest: string;
}

/** The one path every writer uses: `DisclosureLog.open(join(dir, "disclosure"))`. */
export function disclosureFileIn(contentDir: string): string {
  return join(contentDir, "disclosure", "disclosure.json");
}

/**
 * Map each trial to the CIDs announced for its digests.
 *
 * `onFault` is called once with the file named when the file exists but cannot be read or
 * parsed. Digests are compared case-insensitively because both sides are hex and neither
 * promises a case: `DisclosureLog` lowercases on write, and a reader that did not would miss
 * every entry the day a producer stopped normalizing.
 */
export function disclosedCids(
  contentDir: string,
  trials: Iterable<TrialDigests>,
  onFault: (message: string) => void,
): DisclosureEntry[] {
  const file = disclosureFileIn(contentDir);
  let specs: Record<string, unknown>;
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8")) as { specs?: Record<string, unknown> };
    specs = parsed.specs ?? {};
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
      // Name the file: a JSON parse error alone says nothing about which of a service's
      // many inputs failed, and this is the one an operator has to go and fix.
      onFault(`${file}: ${err instanceof Error ? err.message : String(err)}`);
    }
    return [];
  }

  const byDigest = new Map<string, string>();
  for (const [digest, cid] of Object.entries(specs)) {
    if (typeof cid === "string") byDigest.set(digest.toLowerCase(), cid);
  }

  const out: DisclosureEntry[] = [];
  for (const t of trials) {
    const specCID = byDigest.get(t.specDigest.toLowerCase());
    const testsCID = byDigest.get(t.testsDigest.toLowerCase());
    if (specCID || testsCID) out.push({ trialId: t.id, specCID, testsCID });
  }
  return out;
}
