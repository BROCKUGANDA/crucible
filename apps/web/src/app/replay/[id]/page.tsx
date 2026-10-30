"use client";

import { Chrome } from "@/components/Chrome";

export default function ReplayPage() {
  return (
    <Chrome>
      <p className="kicker">Replay Theater</p>
      <h1 className="page-title">Any settled trial, re-enacted</h1>
      <p className="hint hint--block">
        Replays fold the same logs into the same frames on any machine (the reducer is
        pure), so a stored commentary line can prove which frame it spoke about. The
        fork host and the indexer land with P5 and P7.
      </p>
    </Chrome>
  );
}
