import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * The responsive / image / cross-browser gate.
 *
 * Every rule here is read from the file that actually ships. A comment that says "we
 * support old iOS" is not support, and a config object in a test is not the config the
 * build uses — this imports next.config.mjs and parses the real stylesheets. Each
 * assertion corresponds to a defect that was measured on a narrow screen or on an
 * engine without color-mix/svh, so deleting the fix turns the matching check red.
 *
 * Deliberately not asserted: exact colours, font sizes, or breakpoints. Those are design
 * decisions that should be free to move; only the *presence of a fallback* and the
 * *shape of the contract* are load-bearing here.
 */

const WEB = fileURLToPath(new URL("..", import.meta.url));
const read = (relative: string) => readFileSync(join(WEB, relative), "utf8");

function styles(): { name: string; css: string }[] {
  const dir = join(WEB, "src/styles");
  const out = readdirSync(dir)
    .filter((entry) => entry.endsWith(".css"))
    .map((name) => ({ name, css: readFileSync(join(dir, name), "utf8") }));
  out.push({ name: "globals.css", css: read("src/app/globals.css") });
  return out;
}

function tsxSources(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (entry === "node_modules" || entry === ".next" || entry.startsWith(".")) continue;
    // satori markup in the OG route is server-side and never becomes a DOM <img>.
    if (full.includes("/og/") || full.includes("\\og\\")) continue;
    const stats = statSync(full);
    if (stats.isDirectory()) out.push(...tsxSources(full));
    else if (entry.endsWith(".tsx") || entry.endsWith(".jsx")) out.push(full);
  }
  return out;
}

describe("the viewport contract reaches the browser", () => {
  const layout = read("src/app/layout.tsx");

  it("actually reads a layout with a viewport export", () => {
    expect(layout).toContain("export const viewport: Viewport");
  });

  it("opts into safe-area insets instead of leaving them at zero", () => {
    expect(layout).toMatch(/viewportFit:\s*["']cover["']/);
  });

  it("never disables pinch zoom", () => {
    expect(layout).toMatch(/maximumScale:\s*5\b/);
    expect(layout).not.toMatch(/maximumScale:\s*1\b/);
  });
});

/** Import the same object the build consumes, the way csp-media.test.ts does. */
async function webConfig() {
  return (await import("../next.config.mjs")).default as {
    images?: { formats?: string[]; deviceSizes?: number[]; imageSizes?: number[] };
  };
}

describe("images are configured, not just discussed", () => {
  it("declares a modern format contract", async () => {
    const config = await webConfig();
    expect(config.images).toBeDefined();
    expect(config.images?.formats).toEqual(["image/avif", "image/webp"]);
  });

  it("offers widths a phone, a tablet and a desktop each actually request", async () => {
    const config = await webConfig();
    const sizes = config.images?.deviceSizes ?? [];
    expect(sizes).toContain(320);
    expect(sizes).toContain(768);
    expect(sizes).toContain(1280);
    expect([...sizes]).toEqual([...sizes].sort((a, b) => a - b));
  });

  it("routes the one vector hero through next/image", () => {
    expect(read("src/app/page.tsx")).toContain('from "next/image"');
    expect(read("src/app/page.tsx")).toMatch(/<Image\s/);
  });

  it("leaves no raw <img> in the rendered tree", () => {
    const root = join(WEB, "src");
    const raw = tsxSources(root).filter((file) => /<img\s/i.test(readFileSync(file, "utf8")));
    expect(raw.map((file) => file.replace(root, "src"))).toEqual([]);
  });
});

describe("viewport-relative units degrade on older engines", () => {
  it("never writes svh without a vh fallback first", () => {
    const offenders = styles()
      .filter(({ css }) => /\dsvh|100svh/.test(css))
      .filter(({ css }) => {
        const firstSvh = css.search(/(?:\d+(?:\.\d+)?svh|100svh)/);
        const firstVh = css.search(/(?:\d+(?:\.\d+)?vh|100vh)/);
        return firstVh === -1 || firstVh > firstSvh;
      })
      .map(({ name }) => name);
    expect(offenders).toEqual([]);
  });

  it("gives the mobile sheet the visible viewport, not the URL-bar-inclusive one", () => {
    const components = read("src/styles/components.css");
    const panel = components.slice(components.indexOf(".frenchy-widget__panel"));
    const head = panel.slice(0, panel.indexOf("}"));
    expect(head).toMatch(/height:\s*100vh;/);
    expect(head).toMatch(/height:\s*100dvh;/);
    expect(head.indexOf("100vh")).toBeLessThan(head.indexOf("100dvh"));
  });
});

describe("cross-browser surfaces keep their fallback declarations", () => {
  const css = styles().map(({ css }) => css).join("\n");

  it("dims the modal, the chrome and both heat pools without color-mix", () => {
    for (const rgba of [
      "rgba(11, 10, 9, 0.74)", // .scrim
      "rgba(11, 10, 9, 0.82)", // .chrome
      "rgba(11, 10, 9, 0.6)", // frenchy scrim
      "rgba(226, 97, 47, 0.22)", // --ember heat
      "rgba(227, 178, 92, 0.14)", // --gold heat
    ]) {
      expect(css, `missing legacy fallback ${rgba}`).toContain(rgba);
    }
  });

  it("prefixes the blur on every full-page scrim", () => {
    const prefixed = (css.match(/-webkit-backdrop-filter:/g) ?? []).length;
    const plain = (css.match(/(?<!-)\bbackdrop-filter:/g) ?? []).length;
    expect(prefixed).toBeGreaterThanOrEqual(3);
    expect(prefixed).toBeGreaterThanOrEqual(plain);
  });

  it("pads notched viewports in more than one place", () => {
    const files = styles().filter(({ css }) => css.includes("env(safe-area-inset-"));
    expect(files.map(({ name }) => name)).toEqual(
      expect.arrayContaining(["base.css", "arena.css", "components.css", "scrub.css"]),
    );
  });
});

describe("narrow layouts cannot push the page sideways", () => {
  it("keeps the board footer wrapping after the later stylesheet wins", () => {
    const arena = read("src/styles/arena-components.css");
    const block = arena.slice(arena.indexOf(".board-foot {"), arena.indexOf(".board-foot__count"));
    expect(block).toMatch(/flex-wrap:\s*wrap/);
  });

  it("guards the hall receipt grid at phone widths", () => {
    expect(read("src/styles/components.css")).toContain("minmax(min(100%, 240px), 1fr)");
  });

  it("wraps the hero rail and the coarse-pointer targets are thumb-sized", () => {
    expect(read("src/styles/arena.css")).toMatch(/\.arena__nav\s*\{[^}]*flex-wrap:\s*wrap/s);
    const globals = read("src/app/globals.css");
    expect(globals).toMatch(/@media\s*\(pointer:\s*coarse\)/);
    expect(globals).toMatch(/min-height:\s*44px/);
    expect(globals).toContain(".frenchy-widget__dismiss");
  });

  it("does not nest a paragraph inside a paragraph on the sponsor console", () => {
    // A raw string check would also flag the legitimate standalone metric cards. Count
    // open/close tags instead: a depth above one is the real parser bug, because the
    // browser auto-closes the outer paragraph and the DOM diverges across engines.
    let depth = 0;
    let nestedLines = 0;
    for (const line of read("src/app/sponsor/page.tsx").split(/\r?\n/)) {
      depth += (line.match(/<p\b/g) ?? []).length - (line.match(/<\/p>/g) ?? []).length;
      if (depth > 1) nestedLines += 1;
    }
    expect({ nestedLines, finalDepth: depth }).toEqual({ nestedLines: 0, finalDepth: 0 });
  });
});
