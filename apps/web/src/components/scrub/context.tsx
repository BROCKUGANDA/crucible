"use client";

import { createContext, useContext, useEffect, useRef, useState } from "react";
import type { ScrubController } from "@/lib/scrub/progress";
import { ACTS, type Act } from "@/lib/scrub/timeline";

/**
 * The scrub is one number with many readers, so exactly one controller exists per stage and
 * everybody subscribes to it.
 *
 * What is deliberately absent: React state that tracks progress. Re-rendering a tree at
 * 60Hz to move a ruler is the expensive way to do a cheap thing. Components needing a
 * continuous value write to the DOM themselves; only the discrete act index — which crosses
 * six times over the whole page — goes through state.
 */
const ScrubContext = createContext<ScrubController | null>(null);

export function ScrubProvider({
  controller,
  children,
}: {
  controller: ScrubController;
  children: React.ReactNode;
}) {
  useEffect(() => {
    controller.start();
    return () => controller.stop();
  }, [controller]);

  return <ScrubContext.Provider value={controller}>{children}</ScrubContext.Provider>;
}

/** The controller, or null outside a stage. */
export function useScrub(): ScrubController | null {
  return useContext(ScrubContext);
}

// A former `requireScrub` helper — a hook called from a function with no `use`
// prefix, and no callers — was deleted rather than renamed: dead code carrying
// a rules-of-hooks violation is deleted, not taught manners.

/**
 * Subscribe to every published sample without re-rendering. The latest callback is held in a
 * ref so a caller passing an inline closure cannot tear down and rebuild the subscription on
 * every render — the subscription is created once per controller.
 */
export function useScrubSample(handler: (sample: ReturnType<ScrubController["sample"]>) => void) {
  const controller = useScrub();
  const latest = useRef(handler);
  latest.current = handler;

  useEffect(() => {
    if (!controller) return;
    return controller.subscribe((sample) => latest.current(sample));
  }, [controller]);

  return controller;
}

/** Discrete only: re-renders on an act crossing, never on a scroll tick. */
export function useScrubAct(): Act {
  const controller = useScrub();
  const [index, setIndex] = useState(0);

  useEffect(() => {
    if (!controller) return;

    let previous = controller.sample().act;
    return controller.subscribe((sample) => {
      if (sample.act === previous) return;
      previous = sample.act;
      setIndex(sample.act);
    });
  }, [controller]);

  if (!controller) return ACTS[0]!;
  return ACTS[Math.min(ACTS.length - 1, Math.max(0, index))]!;
}
