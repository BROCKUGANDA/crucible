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

/**
 * What Frenchy may do.
 *
 * Two verbs and no money in either of them. The type lives here, beside the
 * map that says where those verbs may point, because the rule that binds them
 * - *the destination has to be a page of this site* - is a property of the
 * site and not of the host that asks.
 */
export interface SiteAction {
  kind: "navigate" | "point";
  /** The page to go to, or the page the point is on. */
  path: string;
  /** The element to point at. Only for `kind: "point"`. */
  point?: string;
  /** Why she is taking them there, in a few words. */
  why: string;
}

/** "Taking you there" is a clause, not an essay. */
export const MAX_WHY_CHARS = 200;

export interface ReadActionResult {
  /** The action, or null when it was refused. */
  action: SiteAction | null;
  /**
   * What was refused, and why.
   *
   * A refusal is worth recording: a model that keeps asking for a page that
   * does not exist is a model whose prompt is out of date, and that is a fact
   * an operator needs to see rather than a silent no-op.
   */
  refused: string[];
}

/**
 * Read an action out of what a model said, and refuse the ones that are not
 * allowed.
 *
 * This is the whole of "computer use" in one check, and it lives here rather
 * than in the host or in the browser because **both of them have to agree**:
 * the server refuses to send an action the browser would refuse to carry out,
 * and a disagreement between the two would be a hole rather than a gate.
 *
 * A refusal is a refusal, not a repair: a path that is not a page of this
 * site is dropped rather than "fixed" into the nearest one, because a
 * navigation to the wrong page is worse than no navigation - the visitor is
 * moved somewhere and told they were somewhere else.
 */
export function readAction(value: unknown): ReadActionResult {
  const refused: string[] = [];
  if (value === null || value === undefined) return { action: null, refused };
  if (typeof value !== "object" || Array.isArray(value)) {
    refused.push("action was not an object");
    return { action: null, refused };
  }
  const action = value as Record<string, unknown>;

  const kind = action.kind;
  if (kind !== "navigate" && kind !== "point") {
    refused.push(`action kind ${JSON.stringify(kind)} is not one of navigate or point`);
    return { action: null, refused };
  }

  const path = typeof action.path === "string" ? action.path.trim() : "";
  if (!path) {
    refused.push("action named no path");
    return { action: null, refused };
  }
  if (!path.startsWith("/")) {
    // A path without its leading slash is not a route, it is a fragment of
    // one. "trials" matched "/trials" when the segments were compared, which
    // is a path the browser would resolve to something else entirely.
    refused.push(`action named ${path}, which is not an absolute path`);
    return { action: null, refused };
  }
  if (!entryForPath(path)) {
    refused.push(`action named ${path}, which is not a page of this site`);
    return { action: null, refused };
  }

  const why = typeof action.why === "string" ? action.why.trim().slice(0, MAX_WHY_CHARS) : "";

  if (kind === "point") {
    const point = typeof action.point === "string" ? action.point.trim() : "";
    if (!point) {
      refused.push("point action named no point");
      return { action: null, refused };
    }
    if (!pointsFor(path).includes(point)) {
      refused.push(`point ${point} is not on ${path}`);
      return { action: null, refused };
    }
    return { action: { kind, path, point, why }, refused };
  }

  return { action: { kind, path, why }, refused };
}
