import { notFound } from "next/navigation";
import { CaseView } from "./case-view";
import { trialIdFromSegment } from "@/lib/trial-id";

/**
 * Tribunal case — a challenged claim, in full.
 *
 * Decides only what the segment can decide (see `/trials/[id]/page.tsx`); the rest
 * resolves from the snapshot in the browser.
 */
export default async function TribunalCasePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const trialId = trialIdFromSegment(id);
  if (trialId === null) notFound();
  return <CaseView id={trialId} />;
}
