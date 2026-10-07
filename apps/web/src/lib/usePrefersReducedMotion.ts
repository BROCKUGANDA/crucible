"use client";

import { useEffect, useState } from "react";

/**
 * `prefers-reduced-motion`, read after mount and kept live.
 *
 * It cannot be decided during render: the server has no media query, so a value read at
 * render time would be a guess that hydrates into a mismatch. It starts `false` and only
 * ever changes inside an effect, which is also why the consumers below use it to gate
 * *behaviour* and never to change markup.
 */
export function usePrefersReducedMotion(): boolean {
  const [reduced, setReduced] = useState(false);

  useEffect(() => {
    if (typeof window.matchMedia !== "function") return;
    const query = window.matchMedia("(prefers-reduced-motion: reduce)");
    setReduced(query.matches);
    const onChange = (event: MediaQueryListEvent) => setReduced(event.matches);
    query.addEventListener("change", onChange);
    return () => query.removeEventListener("change", onChange);
  }, []);

  return reduced;
}
