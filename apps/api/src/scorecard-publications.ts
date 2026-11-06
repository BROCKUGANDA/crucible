import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import type { ScorecardPublicationSource, StoredScorecardPublication } from "./scorecards.js";

/** Read the immutable publication directory without creating or modifying it. */
export function createScorecardPublicationSource(directory: string): ScorecardPublicationSource {
  return (): StoredScorecardPublication[] => {
    if (!existsSync(directory)) return [];
    const entries: StoredScorecardPublication[] = [];
    for (const name of readdirSync(directory).sort()) {
      if (name.startsWith(".") && name.endsWith(".tmp")) continue;
      if (!name.endsWith(".json")) continue;
      const match = /^([0-9a-f]{64})\.json$/.exec(name);
      if (!match) throw new Error(`invalid scorecard publication filename: ${name}`);
      const file = join(directory, name);
      if (!statSync(file).isFile()) throw new Error(`scorecard publication is not a file: ${name}`);
      let value: unknown;
      try {
        value = JSON.parse(readFileSync(file, "utf8")) as unknown;
      } catch {
        throw new Error(`scorecard publication is not valid JSON: ${name}`);
      }
      entries.push({ fileId: match[1]!, value });
    }
    return entries;
  };
}
