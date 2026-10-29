/**
 * The owner's view of the sponsorship queue.
 *
 * The faucet's owner panel is the only place in the product where somebody
 * learns that a stranger asked the treasury for test ETH, so the reading of the
 * host's answer lives here rather than inside the component: "the host could
 * not answer" and "the queue is empty" are different facts, and a page that
 * cannot tell them apart will eventually tell a reader that nothing happened
 * when it did not know.
 */

/**
 * Whether a wallet may read the queue.
 *
 * `unknown` - nothing asked yet.
 * `owner` - this wallet is on the host's owner list.
 * `not-owner` - it is not, and the host says so.
 * `unavailable` - the host could not answer, which is a fact about the host and
 *   not about the wallet.
 */
export type OwnerState = "unknown" | "owner" | "not-owner" | "unavailable";

/** One sponsorship application, as the API records it. */
export interface SponsorshipApplication {
  id: number;
  wallet: string;
  requestedEth: string;
  grantedEth: string | null;
  outcome: "granted" | "refused" | "unanswered";
  reason: string | null;
  at: number;
}

/** One allocation the funder made, as the funder's own ledger records it. */
export interface AllocationRecord {
  wallet: string;
  requested: number;
  granted: number;
  at: string;
  ok: boolean;
  reason?: string | null;
}

/**
 * What the host's answer to a queue read means.
 *
 * The status decides, because the status is the one thing the host cannot get
 * wrong about itself:
 *
 *   * 200 - the wallet is on the owner list and the body carries the queue.
 *   * 403 - the wallet is not on the owner list. Not an error to retry: the
 *     panel simply does not exist for this wallet.
 *   * anything else - the host could not answer. The panel says so; it does not
 *     say the queue is empty.
 */
export function ownerStateFrom(status: number): OwnerState {
  if (status === 200) return "owner";
  if (status === 403) return "not-owner";
  return "unavailable";
}

/**
 * The applications in a queue answer, or null when the body is not one.
 *
 * Null rather than an empty list: an unreadable body is not a queue with
 * nothing in it, and the page says "could not be read" for the first and
 * "nobody has applied" for the second.
 */
export function readApplications(body: unknown): SponsorshipApplication[] | null {
  if (typeof body !== "object" || body === null) return null;
  const applications = (body as { applications?: unknown }).applications;
  if (!Array.isArray(applications)) return null;
  return applications.filter(
    (entry): entry is SponsorshipApplication =>
      typeof entry === "object" &&
      entry !== null &&
      typeof (entry as SponsorshipApplication).id === "number",
  );
}

/**
 * The allocations in a ledger answer, or null when the body is not one.
 */
export function readAllocations(body: unknown): AllocationRecord[] | null {
  if (typeof body !== "object" || body === null) return null;
  const allocations = (body as { allocations?: unknown }).allocations;
  if (!Array.isArray(allocations)) return null;
  return allocations.filter(
    (entry): entry is AllocationRecord =>
      typeof entry === "object" && entry !== null && typeof (entry as AllocationRecord).wallet === "string",
  );
}

/**
 * How many applications arrived since the owner last looked.
 *
 * The queue is ordered newest first, and the ids are monotonic, so the count
 * is the distance between the highest id already seen and the highest id now.
 * The first read counts nothing: a queue that was already full when the owner
 * opened the page is history, not a notification.
 *
 * `seenUpTo` is null until the first read has happened, and it stays null when
 * that read found an empty queue - an owner who opened the page to an empty
 * queue and then had somebody apply must still be told, and "the highest id
 * seen so far is zero" is not the same fact as "the owner has already been
 * shown everything".
 */
export function countNewApplications(
  seenUpTo: number | null,
  applications: SponsorshipApplication[],
): { unseen: number; seenUpTo: number } {
  const highest = applications.reduce((max, a) => Math.max(max, a.id), 0);
  if (seenUpTo === null) return { unseen: 0, seenUpTo: highest };
  if (highest <= seenUpTo) return { unseen: 0, seenUpTo };
  return { unseen: highest - seenUpTo, seenUpTo: highest };
}
