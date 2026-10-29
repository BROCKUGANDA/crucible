import { readFileSync, readdirSync, statSync } from "node:fs";
import { extname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * Every function has a door.
 *
 * A page that exists but is linked from nowhere is not shipped; it is a URL a visitor can only
 * reach by guessing. `/verify` was exactly that — the receipt checker an integrator is told to
 * use, reachable only from `sitemap.ts`, which is a route for crawlers, not a door for people.
 * The browser audit found it by crawling and finding no inbound link.
 *
 * Two properties, both asserted against the tree rather than a render (there is no React
 * renderer here, in the style of `demo-notice.test.ts`):
 *   1. every internal `href` a component can emit resolves to a page that exists, and
 *   2. every page that exists is linked from somewhere — with detail routes reachable by a
 *      template link counted as linked, because `/agents/:id` is a door from `/agents`.
 */

const SRC = fileURLToPath(new URL("../src", import.meta.url));
const APP = join(SRC, "app");

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else out.push(full);
  }
  return out;
}

/** `/agents/[id]/page.tsx` → `/agents/:id`; `app/page.tsx` → `/`. */
function routes(): Set<string> {
  const found = new Set<string>();
  for (const file of walk(APP)) {
    if (!file.endsWith(`${join("", "page.tsx")}`) && !file.endsWith("page.tsx")) continue;
    const rel = file.slice(APP.length).replace(/\\/g, "/").replace(/\/page\.tsx$/, "").replace(/^\/page\.tsx$/, "");
    found.add((rel === "" ? "/" : rel).replace(/\[([^\]]+)\]/g, ":$1"));
  }
  return found;
}

/**
 * Every path a component can navigate to, however it says so.
 *
 * Three shapes ship in this app and all three are doors: a literal `href="/x"`, the same string
 * inside a nav data array (`{ href: "/x", label }`), and programmatic navigation
 * (`router.push(`/x/${id}`)`). The first draft of this test only understood the first, which
 * reported six pages that are in the navigation as orphans — a gate that fails on its own blind
 * spot is worse than no gate, so the extractor learns the shapes instead of the pages being
 * allowlisted.
 */
function links(): Map<string, string> {
  const out = new Map<string, string>();
  const PATTERNS = [
    /href=(?:"([^"]+)"|\{`([^`]+)`\})/g, // JSX attribute
    /href:\s*"([^"]+)"/g, // nav data arrays
    /(?:router\.(?:push|replace)|redirect)\(\s*[`"]([^`"]+)[`"]/g, // programmatic
  ];
  for (const file of walk(SRC)) {
    if (![".tsx", ".ts"].includes(extname(file))) continue;
    if (file.includes(`${join("", "app", "sitemap")}`)) continue; // crawler routes are not doors
    const source = readFileSync(file, "utf8");
    for (const pattern of PATTERNS) {
      for (const m of source.matchAll(pattern)) {
        const raw = m[1] ?? m[2] ?? "";
        if (!raw.startsWith("/")) continue;
        const normal = raw.replace(/\$\{[^}]*\}/g, ":id").replace(/\/$/, "") || "/";
        out.set(normal, file.slice(SRC.length).replace(/\\/g, "/"));
      }
    }
  }
  return out;
}

/** Routes served by something that is not a page — an API proxy, the well-known surface. */
const NOT_A_PAGE = new Set(["/compliance", "/llms", "/llms.txt", "/llms-full.txt", "/og/:id", "/content/:id"]);

const PAGES = routes();
const LINKS = links();

function resolves(target: string): boolean {
  if (PAGES.has(target) || NOT_A_PAGE.has(target)) return true;
  // A concrete link can land on a dynamic page: `/trials/7` → `/trials/:id`.
  return [...PAGES].some((page) => {
    if (!page.includes(":")) return false;
    const pattern = new RegExp(`^${page.replace(/:[^/]+/g, "[^/]+")}$`);
    return pattern.test(target);
  });
}

describe("every link a component can emit lands on something", () => {
  it("has no internal href pointing at a route that does not exist", () => {
    const dead = [...LINKS].filter(([target]) => !resolves(target)).map(([target, from]) => `${target} (from ${from})`);
    expect(dead, `dead internal links:\n${dead.join("\n")}`).toEqual([]);
  });
});

describe("every page is reachable from somewhere", () => {
  it("links every page, treating a template link as the door to a detail page", () => {
    const targetSet = new Set(LINKS.keys());
    const orphans = [...PAGES].filter((page) => {
      if (page === "/") return false; // the wordmark is the door
      if (targetSet.has(page)) return false;
      // `/agents/:id` is linked as `/agents/${id}` (normalised to the same shape) or by a
      // concrete id — resolve both.
      return ![...targetSet].some((t) => resolves(t) && matches(page, t));
    });
    expect(orphans, `pages with no inbound link:\n${orphans.join("\n")}`).toEqual([]);
  });

  it("gives the receipt verifier a door in the chrome, not just in the sitemap", () => {
    // The specific orphan the browser audit found. Kept as its own assertion so a future
    // refactor of the footer cannot quietly drop the only human path to the trust artifact.
    expect(LINKS.has("/verify"), "/verify has no inbound link outside sitemap.ts").toBe(true);
    const chrome = readFileSync(join(SRC, "components", "Chrome.tsx"), "utf8");
    expect(chrome).toMatch(/href="\/verify"/);
  });
});

function matches(page: string, concrete: string): boolean {
  if (!page.includes(":")) return page === concrete;
  return new RegExp(`^${page.replace(/:[^/]+/g, "[^/]+")}$`).test(concrete);
}
