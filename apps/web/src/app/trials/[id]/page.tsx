import { notFound } from "next/navigation";
import { TrialDetail } from "./trial-detail";
import { trialIdFromSegment } from "@/lib/trial-id";

/**
 * The route's status decision, made on the server.
 *
 * Until 2026-10-29 this file *was* the client page, and the deployed origin answered
 * `/trials/999`, `/trials/0` and `/trials/abc` with **HTTP 200** around the site's "Lost slag."
 * not-found body. A client component cannot set a status: it paints the same document whatever
 * the segment says, and by the time it knows there is nothing to paint, the 200 has been sent.
 *
 * So the page is a server component that decides what the segment alone can decide, and hands
 * everything else to `./trial-detail`. `src/lib/trial-id.ts` is the predicate and the argument
 * for it: ids are positive integers minted by `id = ++trialCount`, and every link this app writes
 * is canonical decimal — so `/trials/0`, `/trials/-3`, `/trials/1.5`, `/trials/007` and
 * `/trials/abc` name nothing, on arithmetic alone, and get a genuine 404 through `notFound()`.
 *
 * **What this does not claim.** `/trials/999` is a well-formed id and this page cannot know that
 * no trial carries it: this project has no database (ADR-0008, the indexer is in-memory and
 * `apps/api` is the only reader) and the browser streams the projection from there. Answering
 * "does 999 exist" at render time would put a chain read into every page request, which is a
 * different architecture, not a stricter header. That case still renders "Lost slag." with a
 * 200 — the honest remainder, named rather than papered over.
 */
export default async function TrialDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const trialId = trialIdFromSegment(id);
  if (trialId === null) notFound();
  return <TrialDetail id={trialId} />;
}
