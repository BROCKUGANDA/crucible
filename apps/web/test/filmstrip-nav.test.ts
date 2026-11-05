import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const chrome = readFileSync(new URL("../src/components/Chrome.tsx", import.meta.url), "utf8");
const styles = readFileSync(new URL("../src/styles/components.css", import.meta.url), "utf8");
const motion = readFileSync(new URL("../src/styles/motion.css", import.meta.url), "utf8");

describe("cinematic filmstrip navigation", () => {
  it("keeps one accessible set of real navigation links and marks the visual repeat inert", () => {
    expect(chrome).toContain('aria-label="Primary" className="chrome__nav"');
    expect(chrome).toContain('className="chrome__nav-track"');
    expect(chrome).toContain('aria-hidden="true"');
    expect(chrome).toContain('inert');
    expect(chrome).toContain('className="chrome__nav-links"');
  });

  it("keeps the filmstrip horizontally navigable on compact screens", () => {
    expect(styles).toMatch(/\.chrome__nav\s*\{[^}]*overflow:\s*hidden/s);
    expect(styles).toMatch(/@media\s*\(max-width:\s*1320px\)[\s\S]*?\.chrome__nav\s*\{[^}]*display:\s*block/s);
  });

  it("pauses the marquee for pointer and keyboard interaction", () => {
    expect(styles).toMatch(/\.chrome__nav:hover[\s\S]*?animation-play-state:\s*paused/s);
    expect(styles).toMatch(/\.chrome__nav:focus-within[\s\S]*?animation-play-state:\s*paused/s);
  });

  it("respects reduced motion without removing navigation", () => {
    expect(motion).toMatch(/@media\s*\(prefers-reduced-motion:\s*reduce\)[\s\S]*?\.chrome__nav-track\s*\{\s*animation:\s*none/s);
  });
});
