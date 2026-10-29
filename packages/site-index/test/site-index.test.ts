import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import {
  entryFor,
  entryForPath,
  indexAsPrompt,
  isKnownPath,
  matchesRoute,
  pointsFor,
  siteIndex,
} from "../src/index.js";

/**
 * The site index, and the promises it makes.
 *
 * The index is generated, so the question this file answers is not "is the
 * data right?" but "does the generator refuse to write a map that lies?".
 * Three things have to hold at once: every page of the site is in the map,
 * every route in the map is a page that exists, and every point the map
 * promises is an id the page really carries.
 */

const ROOT = resolve(__dirname, "..", "..", "..");
const APP_DIR = join(ROOT, "apps", "web", "src", "app");

/** The routes that are not pages, and so have nothing to describe. */
const NOT_PAGES = new Set(["llms.txt", "llms-full.txt", "llms", "og", ".well-known", "robots.txt", "sitemap.xml"]);

function routeDirectories(dir: string, out: string[] = []): string[] {
  const names = readdirSync(dir);
  if (names.some((f) => f === "page.tsx" || f === "route.ts")) out.push(dir);
  for (const name of names) {
    if (name.startsWith(".")) continue;
    const full = join(dir, name);
    if (!statSync(full).isDirectory()) continue;
    routeDirectories(full, out);
  }
  return out;
}

function routeFor(dir: string): string {
  const rel = relative(APP_DIR, dir).replace(/\\/g, "/");
  return rel === "" ? "/" : `/${rel}`;
}

function routeSource(dir: string): string {
  return readdirSync(dir)
    .filter((f) => f.endsWith(".tsx") || f.endsWith(".ts"))
    .map((f) => readFileSync(join(dir, f), "utf8"))
    .join("\n");
}

describe("the map covers the site", () => {
  const routes = routeDirectories(APP_DIR).filter((d) => {
    const rel = relative(APP_DIR, d).replace(/\\/g, "/");
    return !rel.split("/").some((part) => NOT_PAGES.has(part));
  });

  it("has an entry for every page of the site", () => {
    const known = new Set(siteIndex.map((e) => e.path));
    const missing = routes.map(routeFor).filter((r) => !known.has(r));
    expect(missing).toEqual([]);
  });

  it("has no entry for a route that does not exist", () => {
    const real = new Set(routes.map(routeFor));
    const invented = siteIndex.map((e) => e.path).filter((p) => !real.has(p));
    expect(invented).toEqual([]);
  });

  it("names no page twice", () => {
    const paths = siteIndex.map((e) => e.path);
    expect(new Set(paths).size).toBe(paths.length);
  });

  it("promises only points the page really carries", () => {
    const byRoute = new Map(routes.map((d) => [routeFor(d), routeSource(d)]));
    const broken: string[] = [];
    for (const entry of siteIndex) {
      const source = byRoute.get(entry.path);
      if (!source) continue;
      for (const point of entry.points ?? []) {
        if (!source.includes(`id="${point}"`)) broken.push(`${entry.path}: ${point}`);
      }
    }
    expect(broken).toEqual([]);
  });

  it("says what every page is for, in words", () => {
    const thin = siteIndex
      .filter((e) => e.purpose.trim().length < 20 || e.can.length === 0)
      .map((e) => e.path);
    expect(thin).toEqual([]);
  });
});

describe("matching a path to a page", () => {
  it("matches a literal route", () => {
    expect(matchesRoute("/trials", "/trials")).toBe(true);
    expect(matchesRoute("/trials", "/trials/12")).toBe(false);
  });

  it("matches a dynamic route on any one segment", () => {
    expect(matchesRoute("/trials/[id]", "/trials/12")).toBe(true);
    expect(matchesRoute("/trials/[id]/replay", "/trials/12/replay")).toBe(true);
    expect(matchesRoute("/trials/[id]", "/trials/12/replay")).toBe(false);
  });

  it("does not match a path that is longer or shorter", () => {
    expect(matchesRoute("/trials", "/trials/12")).toBe(false);
    expect(matchesRoute("/trials/[id]", "/trials")).toBe(false);
  });

  it("finds the entry a concrete path belongs to", () => {
    expect(entryForPath("/trials/12")?.path).toBe("/trials/[id]");
    expect(entryForPath("/trials")?.path).toBe("/trials");
  });

  it("knows a page from a path that is not one", () => {
    expect(isKnownPath("/trials")).toBe(true);
    expect(isKnownPath("/trials/12")).toBe(true);
    expect(isKnownPath("/not-a-page")).toBe(false);
    expect(isKnownPath("/trials/12/replay/extra")).toBe(false);
    expect(entryForPath("/not-a-page")).toBeNull();
  });

  it("finds an entry by its exact pattern", () => {
    expect(entryFor("/trials/[id]")?.label).toBe("Trial");
    expect(entryFor("/trials/12")).toBeNull();
  });
});

describe("the points a page offers", () => {
  it("lists the ids the page declares", () => {
    expect(pointsFor("/trials")).toContain("trial-table");
  });

  it("lists nothing for a page that declares nothing", () => {
    expect(pointsFor("/verify")).toEqual([]);
  });
});

describe("the index as the prompt carries it", () => {
  it("names every page with its purpose", () => {
    const text = indexAsPrompt();
    for (const entry of siteIndex) {
      expect(text).toContain(entry.path);
    }
    expect(text).toContain("/trials");
    expect(text).toContain("trial-table");
  });

  it("is one line per page, so the prompt does not grow without bound", () => {
    const lines = indexAsPrompt().split("\n");
    expect(lines.length).toBe(siteIndex.length);
  });
});
