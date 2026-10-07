import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { drawScene } from "@/lib/scrub/scene";
import type { SceneCtx, SceneGradient } from "@/lib/scrub/scene";

/**
 * A context that records instead of painting.
 *
 * There is no canvas in node, and faking one that produced pixels would prove nothing. What
 * is actually being asserted here is *statelessness and sensitivity*: the same progress must
 * draw the same calls, different progress must draw different calls, and the only inputs are
 * the ones in `SceneInput`. Every argument is folded into the op log so a change in geometry
 * or colour shows up as a diff.
 */
/** A canvas state snapshot, for the recorder's save/restore stack. */
interface Saved {
  fillStyle: string | SceneGradient;
  strokeStyle: string | SceneGradient;
  globalAlpha: number;
  lineWidth: number;
  font: string;
  textAlign: string;
  textBaseline: string;
}

class Recorder implements SceneCtx {
  ops: string[] = [];
  fillStyle: string | SceneGradient = "#000000";
  strokeStyle: string | SceneGradient = "#000000";
  lineWidth = 1;
  globalAlpha = 1;
  font = "";
  textAlign = "start";
  textBaseline = "alphabetic";

  private note(name: string, ...args: (string | number)[]) {
    this.ops.push(`${name}(${args.join(",")})|a=${this.globalAlpha}|f=${String(this.fillStyle)}|s=${String(this.strokeStyle)}`);
  }

  /**
   * A state stack, because a canvas has one. Without it `restore()` is a no-op in the double,
   * so a layer that set `globalAlpha` inside a save/restore pair leaks into the next layer's
   * recorded state — and the "a walked frame equals a cold frame" assertion below then fails
   * on a defect that exists only in the test rig. The stack makes this double behave like the
   * thing it is standing in for.
   */
  private stack: Saved[] = [];

  save() {
    this.stack.push({
      fillStyle: this.fillStyle,
      strokeStyle: this.strokeStyle,
      globalAlpha: this.globalAlpha,
      lineWidth: this.lineWidth,
      font: this.font,
      textAlign: this.textAlign,
      textBaseline: this.textBaseline,
    });
    this.ops.push("save");
  }
  restore() {
    const saved = this.stack.pop();
    if (saved) {
      this.fillStyle = saved.fillStyle;
      this.strokeStyle = saved.strokeStyle;
      this.globalAlpha = saved.globalAlpha;
      this.lineWidth = saved.lineWidth;
      this.font = saved.font;
      this.textAlign = saved.textAlign;
      this.textBaseline = saved.textBaseline;
    }
    this.ops.push("restore");
  }
  beginPath() {
    this.ops.push("beginPath");
  }
  /** How many `save()`s never found a `restore()`. The scene must leave this at zero. */
  get openGroups(): number {
    return this.stack.length;
  }
  closePath() {
    this.ops.push("closePath");
  }
  moveTo(x: number, y: number) {
    this.note("moveTo", x.toFixed(2), y.toFixed(2));
  }
  lineTo(x: number, y: number) {
    this.note("lineTo", x.toFixed(2), y.toFixed(2));
  }
  quadraticCurveTo(cx: number, cy: number, x: number, y: number) {
    this.note("quad", cx.toFixed(2), cy.toFixed(2), x.toFixed(2), y.toFixed(2));
  }
  arc(x: number, y: number, r: number, a0: number, a1: number) {
    this.note("arc", x.toFixed(2), y.toFixed(2), r.toFixed(2), a0.toFixed(3), a1.toFixed(3));
  }
  ellipse(
    x: number,
    y: number,
    rx: number,
    ry: number,
    rot: number,
    a0: number,
    a1: number,
  ) {
    this.note(
      "ellipse",
      x.toFixed(2),
      y.toFixed(2),
      rx.toFixed(2),
      ry.toFixed(2),
      rot.toFixed(3),
      a0.toFixed(3),
      a1.toFixed(3),
    );
  }
  rect(x: number, y: number, w: number, h: number) {
    this.note("rect", x.toFixed(2), y.toFixed(2), w.toFixed(2), h.toFixed(2));
  }
  fill() {
    this.ops.push(`fill|a=${this.globalAlpha}|f=${String(this.fillStyle)}`);
  }
  stroke() {
    this.ops.push(`stroke|a=${this.globalAlpha}|s=${String(this.strokeStyle)}|w=${this.lineWidth}`);
  }
  fillRect(x: number, y: number, w: number, h: number) {
    this.note("fillRect", x.toFixed(2), y.toFixed(2), w.toFixed(2), h.toFixed(2));
  }
  fillText(text: string, x: number, y: number) {
    this.note("fillText", text, x.toFixed(2), y.toFixed(2), this.font);
  }
  translate(x: number, y: number) {
    this.note("translate", x.toFixed(2), y.toFixed(2));
  }
  scale(x: number, y: number) {
    this.note("scale", x.toFixed(3), y.toFixed(3));
  }
  createLinearGradient(x0: number, y0: number, x1: number, y1: number): SceneGradient {
    this.note("linearGradient", x0.toFixed(2), y0.toFixed(2), x1.toFixed(2), y1.toFixed(2));
    // Stops are labelled without an id: their position in the log already binds them to the
    // gradient they were added to, and an id derived from log length would make a walked
    // frame differ from a cold one for a reason that has nothing to do with the drawing.
    return {
      addColorStop: (offset: number, color: string) => {
        this.ops.push(`stop(${offset.toFixed(3)},${color})`);
      },
    };
  }
  createRadialGradient(
    x0: number,
    y0: number,
    r0: number,
    x1: number,
    y1: number,
    r1: number,
  ): SceneGradient {
    this.note("radialGradient", x0.toFixed(2), y0.toFixed(2), r0.toFixed(2), x1.toFixed(2), y1.toFixed(2), r1.toFixed(2));
    return {
      addColorStop: (offset: number, color: string) => {
        this.ops.push(`stop(${offset.toFixed(3)},${color})`);
      },
    };
  }
}

const SIZE = { w: 1280, h: 800 };

function paint(progress: number, extra: Record<string, unknown> = {}): string {
  const rec = new Recorder();
  drawScene(rec, SIZE, { progress, ...extra } as Parameters<typeof drawScene>[2]);
  return rec.ops.join("\n");
}

describe("scrub scene", () => {
  it("draws the same calls for the same progress", () => {
    expect(paint(0.62)).toBe(paint(0.62));
  });

  it("draws different calls for different progress", () => {
    expect(paint(0.05)).not.toBe(paint(0.5));
    expect(paint(0.5)).not.toBe(paint(0.97));
  });

  it("rewinds exactly: forward then back returns the identical frame", () => {
    const before = paint(0.18);
    paint(0.9);
    paint(0.4);
    expect(paint(0.18)).toBe(before);
  });

  it("has no hidden state — a walked frame equals a cold one", () => {
    const walked = new Recorder();
    drawScene(walked, SIZE, { progress: 0.2 });
    const mark = walked.ops.length;
    drawScene(walked, SIZE, { progress: 0.45 });
    const tail = walked.ops.slice(mark).join("\n");

    const cold = new Recorder();
    drawScene(cold, SIZE, { progress: 0.45 });

    expect(mark).toBeGreaterThan(0);
    expect(tail).toBe(cold.ops.join("\n"));
  });

  it("narrates the settlement it was given", () => {
    const paid = paint(0.95, { mark: "paid" });
    const slashed = paint(0.95, { mark: "slashed" });
    const refunded = paint(0.95, { mark: "refunded" });
    expect(paid).not.toBe(slashed);
    expect(slashed).not.toBe(refunded);
    expect(paid).toContain("#");
  });

  it("draws more crowd when more smiths are registered", () => {
    const empty = new Recorder();
    drawScene(empty, SIZE, { progress: 0.5, crowd: 0 });
    const full = new Recorder();
    drawScene(full, SIZE, { progress: 0.5, crowd: 1 });
    expect(full.ops.length).toBeGreaterThan(empty.ops.length);
  });

  it("paints every act, so no band of scroll is a frozen frame", () => {
    for (const p of [0.02, 0.2, 0.4, 0.6, 0.8, 0.98]) {
      const rec = new Recorder();
      drawScene(rec, SIZE, { progress: p });
      expect(rec.ops.length).toBeGreaterThan(40);
    }
  });

  it("never reaches for the clock or for randomness", () => {
    // The rewind property above would break the moment someone adds `Date.now()` to a layer,
    // and it would break quietly: the scene would still look right while scrubbing backwards
    // started drifting. Asserting the source is the only cheap way to hold that line.
    const source = readFileSync(
      fileURLToPath(new URL("../src/lib/scrub/scene.ts", import.meta.url)),
      "utf8",
    );
    for (const forbidden of ["Date.now", "performance.now", "Math.random", "requestAnimationFrame", "setTimeout"]) {
      expect(source, `scene.ts must not use ${forbidden}`).not.toContain(forbidden);
    }
  });

  it("opens and closes every group it starts", () => {
    for (const p of [0, 0.2, 0.45, 0.7, 0.95, 1]) {
      const rec = new Recorder();
      drawScene(rec, SIZE, { progress: p, mark: "paid", crowd: 0.5 });
      expect(rec.openGroups, `unbalanced save/restore at progress ${p}`).toBe(0);
    }
  });

  it("survives the degenerate sizes a viewport can actually be", () => {
    for (const size of [{ w: 1, h: 1 }, { w: 320, h: 2000 }, { w: 3840, h: 1200 }]) {
      const rec = new Recorder();
      expect(() => drawScene(rec, size, { progress: 0.5, crowd: 0.5 })).not.toThrow();
      expect(rec.ops.length).toBeGreaterThan(10);
    }
  });
});
