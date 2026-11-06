import { randomUUID } from "node:crypto";
import { linkSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { scorecardPublicationId, type ScorecardPublication } from "@crucible/smith";

export interface ScorecardPublicationWrite {
  id: string;
  path: string;
  replayed: boolean;
}

/**
 * Persist a signed publication under its stable cohort/agent/scorecard replay key. The hard link
 * publishes a complete file atomically and refuses to replace an existing id; an identical retry
 * is idempotent, while a new timestamp or signature for the same scorecard is a conflict.
 */
export function writeScorecardPublication(
  directory: string,
  publication: ScorecardPublication,
): ScorecardPublicationWrite {
  const expectedId = scorecardPublicationId(publication.message);
  if (publication.schemaVersion !== 1 || publication.id.toLowerCase() !== expectedId.toLowerCase()) {
    throw new Error("scorecard publication id does not match its signed message");
  }
  const serialized = `${JSON.stringify(publication, null, 2)}\n`;
  mkdirSync(directory, { recursive: true });
  const finalPath = join(directory, `${expectedId.slice(2).toLowerCase()}.json`);
  const temporaryPath = join(directory, `.${randomUUID()}.tmp`);
  writeFileSync(temporaryPath, serialized, { flag: "wx" });

  try {
    try {
      linkSync(temporaryPath, finalPath);
      return { id: expectedId, path: finalPath, replayed: false };
    } catch (error) {
      if (!error || typeof error !== "object" || !("code" in error) || error.code !== "EEXIST") {
        throw error;
      }
      const existing = readFileSync(finalPath, "utf8");
      if (existing !== serialized) {
        throw new Error(`scorecard publication replay conflict for ${expectedId}`);
      }
      return { id: expectedId, path: finalPath, replayed: true };
    }
  } finally {
    rmSync(temporaryPath, { force: true });
  }
}
