/**
 * The site index: one map of the site, read by Frenchy and by the Tour page.
 *
 * The data is generated (`src/generated.ts`) from the descriptors each page
 * declares, so this file is the *shape* of the map and the helpers that read
 * it - not a second copy of the map. Two readers, one source.
 */

import { SITE_INDEX } from "./generated.js";
import type { SiteEntry } from "./types.js";

export type { SiteEntry } from "./types.js";
export { SITE_INDEX } from "./generated.js";

/** Every route in the app that carries a descriptor. */
export const siteIndex: readonly SiteEntry[] = SITE_INDEX;

/**
 * Does a concrete path match a route pattern?
 *
 * `/trials` matches `/trials`. `/trials/12` matches `/trials/[id]`, and
 * `/trials/12/replay` does not - a path is matched whole or not at all, so a
 * Frenchy who says `/trials/12/replay` is sent to the replay page and not to
 * the trial.
 */
export function matchesRoute(pattern: string, path: string): boolean {
  const patternParts = pattern.split("/").filter((p) => p.length > 0);
  const pathParts = path.split("/").filter((p) => p.length > 0);
  if (patternParts.length !== pathParts.length) return false;
  return patternParts.every((part, i) => {
    const actual = pathParts[i] ?? "";
    if (part.startsWith("[") && part.endsWith("]")) return actual.length > 0;
    return part === actual;
  });
}

/**
 * The entry for a route pattern, exactly.
 *
 * `"/trials"` finds the trials page; `"/trials/12"` does not, because the
 * pattern for a dynamic route is written with its brackets.
 */
export function entryFor(pattern: string): SiteEntry | null {
  return siteIndex.find((entry) => entry.path === pattern) ?? null;
}

/**
 * The entry a concrete path belongs to.
 *
 * This is what a redirect is checked against: a path that no entry claims is
 * not a page of this site, and Frenchy is not allowed to send anyone to a
 * page that does not exist.
 */
export function entryForPath(path: string): SiteEntry | null {
  return siteIndex.find((entry) => matchesRoute(entry.path, path)) ?? null;
}

/** True when `path` is a page of this site. */
export function isKnownPath(path: string): boolean {
  return entryForPath(path) !== null;
}

/**
 * Every route, as the navigation writes it.
 *
 * The list the prompt carries, and the list the Tour page renders.
 */
export function knownPaths(): string[] {
  return siteIndex.map((entry) => entry.path);
}

/**
 * The ids Frenchy may point at on a page.
 *
 * A point that the page does not carry is dropped rather than attempted: the
 * point is a promise about where the eye should go, and a promise the page
 * does not keep is worse than no promise.
 */
export function pointsFor(path: string): string[] {
  const entry = entryForPath(path);
  return entry?.points ?? [];
}

/**
 * The index as a block of text, for the prompt.
 *
 * One line per page: the route, what it is for, and what a visitor can do
 * there. The action vocabulary is not repeated here - it belongs to the
 * prompt's action policy, not to the map - but the points are, because they
 * are properties of the page.
 */
export function indexAsPrompt(): string {
  return siteIndex
    .map((entry) => {
      const can = entry.can.length > 0 ? ` You can: ${entry.can.join("; ")}.` : "";
      const points = entry.points?.length ? ` Points: ${entry.points.join(", ")}.` : "";
      const needs = entry.needs ? ` Needs: ${entry.needs}.` : "";
      return `- ${entry.path} (${entry.label}) - ${entry.purpose}${can}${points}${needs}`;
    })
    .join("\n");
}
