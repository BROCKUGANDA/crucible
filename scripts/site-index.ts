/**
 * The site index generator.
 *
 * Reads the descriptor each route declares (`apps/web/src/app/**\/site.ts`) and
 * writes `packages/site-index/src/generated.ts` - the one map that Frenchy is
 * grounded in and that the Tour page renders.
 *
 * It refuses to write a map that lies:
 *
 *   * a route directory with no descriptor is an error, not a silent gap;
 *   * a descriptor whose `path` does not match the route it sits in is an
 *     error, so a moved page cannot keep the old address;
 *   * a declared point must exist as an `id` in that route's own source, so a
 *     point that lands nowhere is refused rather than shipped.
 *
 * Run it with `npm run site-index`. `npm run site-index:check` regenerates in
 * memory and fails on drift. Both are local commands: on the runner's Node 20 the
 * `tsx/esm` loader cannot evaluate a descriptor without hitting
 * ERR_REQUIRE_CYCLE_MODULE, so what CI enforces is the suite in
 * `packages/site-index/test/site-index.test.ts` — coverage, no invented routes, and
 * every promised point present on the page. See the note in `.github/workflows/ci.yml`.
 */

import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";

/** `--check` regenerates in memory and refuses when the committed map differs. */
const CHECK = process.argv.includes("--check");

const ROOT = resolve(process.cwd());
const APP_DIR = join(ROOT, "apps", "web", "src", "app");
const OUT_FILE = join(ROOT, "packages", "site-index", "src", "generated.ts");

/**
 * The routes that are not pages.
 *
 * A machine route has no human to describe and nothing to point at, so the
 * index has nothing to say about it. Every one of them is listed here by name
 * rather than matched by a pattern, because a pattern would quietly swallow a
 * page someone forgot.
 */
const NOT_PAGES = new Set([
  "ai",
  "llms.txt",
  "llms-full.txt",
  "llms",
  "og",
  ".well-known",
  "robots.txt",
  "sitemap.xml",
]);

interface Descriptor {
  path: string;
  label: string;
  purpose: string;
  can: string[];
  points?: string[];
  needs?: string;
}

/** Every directory under the app that holds a page. */
function routeDirectories(dir: string, out: string[] = []): string[] {
  const names = readdirSync(dir);
  // A directory with a page in it is a route - including a dynamic one, whose
  // page lives inside the bracketed directory.
  if (names.some((f) => f === "page.tsx" || f === "route.ts")) out.push(dir);
  for (const name of names) {
    if (name.startsWith(".")) continue;
    const full = join(dir, name);
    if (!statSync(full).isDirectory()) continue;
    routeDirectories(full, out);
  }
  return out;
}

/** The route a directory is, as the app router writes it. */
function routeFor(dir: string): string {
  const rel = relative(APP_DIR, dir).replace(/\\/g, "/");
  return rel === "" ? "/" : `/${rel}`;
}

/** Every source file in a route's own folder, so a point can live in a component. */
function routeSource(dir: string): string {
  return readdirSync(dir)
    .filter((f) => f.endsWith(".tsx") || f.endsWith(".ts"))
    .map((f) => readFileSync(join(dir, f), "utf8"))
    .join("\n");
}

function isDescriptor(value: unknown): value is Descriptor {
  if (typeof value !== "object" || value === null) return false;
  const d = value as Record<string, unknown>;
  return (
    typeof d.path === "string" &&
    typeof d.label === "string" &&
    typeof d.purpose === "string" &&
    Array.isArray(d.can) &&
    d.can.every((c) => typeof c === "string") &&
    (d.points === undefined ||
      (Array.isArray(d.points) && d.points.every((p) => typeof p === "string"))) &&
    (d.needs === undefined || typeof d.needs === "string")
  );
}

async function main(): Promise<void> {
  const dirs = routeDirectories(APP_DIR).filter((d) => {
    const rel = relative(APP_DIR, d).replace(/\\/g, "/");
    return !rel.split("/").some((part) => NOT_PAGES.has(part));
  });

  const entries: Descriptor[] = [];
  const problems: string[] = [];

  for (const dir of dirs) {
    const descriptorFile = join(dir, "site.ts");
    if (!readdirSync(dir).includes("site.ts")) {
      problems.push(`${routeFor(dir)} has no descriptor (expected ${relative(ROOT, descriptorFile)})`);
      continue;
    }
    const mod = (await import(pathToFileURL(descriptorFile).href)) as { siteEntry?: unknown };
    const descriptor = mod.siteEntry;
    if (!isDescriptor(descriptor)) {
      problems.push(`${routeFor(dir)}: site.ts does not export a usable siteEntry`);
      continue;
    }
    if (descriptor.path !== routeFor(dir)) {
      problems.push(
        `${routeFor(dir)}: its descriptor claims the path ${descriptor.path} - the descriptor and the route must agree`,
      );
      continue;
    }
    const source = routeSource(dir);
    for (const point of descriptor.points ?? []) {
      if (!source.includes(`id="${point}"`)) {
        problems.push(
          `${descriptor.path}: points at "${point}", which is not an id on this page - a point that lands nowhere is not shipped`,
        );
      }
    }
    entries.push(descriptor);
  }

  if (problems.length > 0) {
    console.error("The site index cannot be generated:");
    for (const problem of problems) console.error(`  - ${problem}`);
    process.exit(1);
  }

  entries.sort((a, b) => a.path.localeCompare(b.path));

  const body = `/**
 * The site index, generated. Do not edit by hand.
 *
 * Written by \`scripts/site-index.ts\` from the descriptor each route declares
 * (a \`site.ts\` beside the route's own page). Run \`npm run site-index\` after
 * adding a page or moving one. What CI enforces is the suite in
 * \`packages/site-index/test/site-index.test.ts\`: every page has an entry, no entry
 * names a route that does not exist, and every point promised here is an id the
 * page really carries.
 *
 * Two readers, one map: Frenchy is grounded in it and the Tour page renders
 * it, so the map a visitor reads and the map the assistant acts on cannot
 * disagree.
 */

import type { SiteEntry } from "./types.js";

export const SITE_INDEX: SiteEntry[] = ${JSON.stringify(entries, null, 2)};
`;

  if (CHECK) {
    // Line endings folded, for the reason spelled out in `.gitattributes` and in
    // `scripts/params-codegen.mjs`: this body is a template literal, so its newlines are this
    // file's, and a Windows checkout smudges the committed artifact to CRLF. Comparing raw
    // bytes would guard the line ending and miss the map.
    const fold = (s: string) => s.replace(/\r\n/g, "\n");
    const onDisk = existsSync(OUT_FILE) ? readFileSync(OUT_FILE, "utf8") : "";
    if (fold(onDisk) !== fold(body)) {
      console.error(
        `site index drift: ${relative(ROOT, OUT_FILE)} does not match the route descriptors.\n` +
          "  A page was added, moved, or reworded without regenerating the map Frenchy is grounded in.\n" +
          "  Regenerate with: npm run site-index",
      );
      process.exit(1);
    }
    console.log(`site-index:check green — ${entries.length} entries match the pages that carry them`);
    return;
  }

  writeFileSync(OUT_FILE, body, "utf8");
  console.log(`Wrote ${entries.length} entries to ${relative(ROOT, OUT_FILE)}`);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
