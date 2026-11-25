import { notFound } from "next/navigation";
import { PublicationDetail } from "./publication-detail";
import { publicationIdFromSegment } from "@/lib/publication-id";

/**
 * The route's status decision, made on the server.
 *
 * A published method is content-addressed (`pub_` plus 32 hex characters),
 * so a segment that cannot name one is provably absent — no read is needed
 * to say so, and the answer is a real 404 rather than a page that says
 * "no such publication" under a 200.
 *
 * A well-formed segment with nothing behind it is not decidable here: the
 * card is read from the API in the browser, and the client panel says so
 * honestly. The distinction is the whole point of keeping the predicate
 * separate from the page.
 */
export default async function PublicationPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const publicationId = publicationIdFromSegment(id);
  if (publicationId === null) notFound();
  return <PublicationDetail id={publicationId} />;
}
