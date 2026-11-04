"use client";

import Link from "next/link";
import { useParams } from "next/navigation";
import { Chrome, ColdForge } from "@/components/Chrome";

export default function ReplayPage() {
  const { id } = useParams<{ id: string }>();

  return (
    <Chrome>
      <p className="kicker">Replay Theater</p>
      <h1 className="page-title">Any settled trial, re-enacted</h1>
      <p className="hint hint--block">
        Replays fold the same logs into the same frames on any machine (the reducer is
        pure), so a stored commentary line can prove which frame it spoke about. The
        fork host and the indexer land with P5 and P7.
      </p>
      <ColdForge line="Start from the trial, then watch it re-enacted." cta="Open this trial" href={`/trials/${id}/replay`} />
      <p className="hint hint--block">
        Related doors:{" "}
        <Link href="/arena">Arena</Link>{" "}
        <Link href="/hall">Hall</Link>
      </p>
    </Chrome>
  );
}
