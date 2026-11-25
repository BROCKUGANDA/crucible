import { notFound } from "next/navigation";
import { DisputeEvidence } from "./dispute-evidence";
import { trialIdFromSegment } from "@/lib/trial-id";

/**
 * The route's status decision, made on the server.
 *
 * A trial id is a positive integer (see `lib/trial-id.ts`), so a segment
 * that cannot name one is provably absent and gets a real 404 rather than
 * a page that says "no such dispute" under a 200.
 */
export default async function DisputePage({ params }: { params: Promise<{ trialId: string }> }) {
  const { trialId } = await params;
  const id = trialIdFromSegment(trialId);
  if (id === null) notFound();
  return <DisputeEvidence trialId={String(id)} />;
}
