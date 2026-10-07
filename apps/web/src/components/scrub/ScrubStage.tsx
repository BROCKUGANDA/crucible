"use client";

import { useRef } from "react";
import { ArenaScrub } from "./ArenaScrub";
import { ScrubHud } from "./ScrubHud";
import { ScrubProvider } from "./context";
import { deriveFacts } from "@/lib/scrub/arenaFacts";
import { createScrub, windowSource } from "@/lib/scrub/progress";
import type { ScrubController } from "@/lib/scrub/progress";
import { usePrefersReducedMotion } from "@/lib/usePrefersReducedMotion";
import { useSnapshot } from "@/lib/useSnapshot";

/**
 * The composition root for the cinematic surface, and the only place the scrub is assembled.
 *
 * Layer ownership is the point of this file: one controller, one canvas host, one HUD, and
 * page content passed in as children. A page gets the effect by wrapping its copy in
 * `<ScrubStage>` and stays a server component, which means the words a search engine or a
 * screen reader reads are ordinary HTML — the animation is decoration bolted over the top,
 * not the thing being decorated.
 */
export function ScrubStage({ children }: { children: React.ReactNode }) {
  const controller = useRef<ScrubController | null>(null);
  if (!controller.current) controller.current = createScrub(windowSource());

  const reduced = usePrefersReducedMotion();
  const { data } = useSnapshot();
  const facts = deriveFacts(data);

  return (
    <ScrubProvider controller={controller.current}>
      <div className="scrub" data-motion={reduced ? "static" : "scrub"}>
        <ArenaScrub
          mark={facts.mark}
          crowd={facts.crowd}
          seal={facts.seal ?? ""}
          followsScroll={!reduced}
        />
        <ScrubHud
          trials={facts.trials}
          smiths={facts.smiths}
          settled={facts.settled}
          lastBlock={facts.markBlock}
          showCrowdKey
        />
        <div className="scrub__content">{children}</div>
      </div>
    </ScrubProvider>
  );
}
