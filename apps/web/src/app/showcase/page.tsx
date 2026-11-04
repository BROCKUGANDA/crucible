"use client";

import Link from "next/link";
import { Chrome, ColdForge } from "@/components/Chrome";

/**
 * Showcase Arena (bible §16.8, gates 796-805).
 *
 * House Bouts run on a separate showcase deployment with shortened windows; Ghost Runs
 * and Replay Theater share this route family. The full live arena lands with P5 (Harena)
 * and P8 (agent surface); this shell keeps the route resolvable and the page honest
 * about what is wired today.
 */
export default function ShowcasePage() {
  return (
    <Chrome>
      <p className="kicker">Showcase Arena</p>
      <h1 className="page-title">The sand, on screen</h1>
      <p className="hint hint--block">
        House Bouts, Ghost Runs and Replay Theater share one event stream. The arena
        events envelope and the frame reducer that fold those events into beats are
        shipped in <span className="mono">@crucible/arena-events</span> and{" "}
        <span className="mono">@crucible/frame</span>; the live room renderer and the
        fork host land with P5 and P8.
      </p>
      <ColdForge line="The live room lands with P5 and P8." cta="Enter the arena" href="/arena" />
      <p className="hint hint--block">
        Related doors:{" "}
        <Link href="/arena">Arena</Link>{" "}
        <Link href="/trials">Trials</Link>{" "}
        <Link href="/hall">Hall</Link>
      </p>
    </Chrome>
  );
}
