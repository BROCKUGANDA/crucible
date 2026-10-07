"use client";

import { useCallback, useEffect, useRef } from "react";
import { useScrubSample } from "./context";
import { canvasMetrics } from "@/lib/scrub/canvasMetrics";
import { asSceneCtx, drawScene } from "@/lib/scrub/scene";
import type { SceneInput } from "@/lib/scrub/scene";

/**
 * The fixed drawing layer.
 *
 * It owns nothing but pixels. The timeline comes from the provider, the facts come in as
 * props, and the scene function is pure. Repaints happen on exactly three events: a published
 * sample whose progress actually moved, a resize, and a change to the data being narrated.
 * There is no animation loop in this file, so a reader who is not scrolling costs zero frames.
 */
export function ArenaScrub({
  mark,
  crowd,
  seal,
  followsScroll = true,
}: {
  mark: SceneInput["mark"];
  crowd: number;
  seal: string;
  /** False under reduced motion: one calm frame instead of a scene that chases the wheel. */
  followsScroll?: boolean;
}) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const buffer = useRef({ w: 0, h: 0, scale: 1 });
  const lastPainted = useRef(-1);

  // The scene input lives in a ref so a repaint can read the *current* data without the
  // subscription being rebuilt every time the index pushes a snapshot.
  const scene = useRef<SceneInput>({ progress: 0, mark, crowd, seal });
  scene.current = { ...scene.current, mark, crowd, seal };

  const paint = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx || buffer.current.w <= 0) return;
    ctx.setTransform(buffer.current.scale, 0, 0, buffer.current.scale, 0, 0);
    drawScene(asSceneCtx(ctx), { w: buffer.current.w, h: buffer.current.h }, scene.current);
  }, []);

  const measure = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    const dpr = typeof window === "undefined" ? 1 : window.devicePixelRatio;
    const next = canvasMetrics(rect.width, rect.height, dpr);
    if (
      next.backingW === canvas.width &&
      next.backingH === canvas.height &&
      next.scale === buffer.current.scale
    ) {
      return;
    }
    canvas.width = next.backingW;
    canvas.height = next.backingH;
    buffer.current = { w: next.backingW, h: next.backingH, scale: next.scale };
    paint();
  }, [paint]);

  useEffect(() => {
    measure();
    if (!followsScroll) {
      // One static frame, at the point where the architecture is most legible.
      lastPainted.current = 0.42;
      scene.current.progress = 0.42;
      paint();
      return;
    }
    const observer =
      typeof ResizeObserver === "function" ? new ResizeObserver(() => measure()) : null;
    if (observer && canvasRef.current) observer.observe(canvasRef.current);
    const onResize = () => measure();
    window.addEventListener("resize", onResize);
    return () => {
      observer?.disconnect();
      window.removeEventListener("resize", onResize);
    };
  }, [followsScroll, measure, paint]);

  // A new settlement or a changed crowd must reach the picture even if nobody scrolls.
  useEffect(() => {
    if (lastPainted.current < 0) return;
    paint();
  }, [mark, crowd, seal, paint]);

  useScrubSample((sample) => {
    if (!followsScroll) return;
    if (sample.progress === lastPainted.current) return;
    lastPainted.current = sample.progress;
    scene.current.progress = sample.progress;
    paint();
  });

  return <canvas ref={canvasRef} className="scrub__canvas" aria-hidden="true" />;
}
