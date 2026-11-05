/**
 * A count of the wallet interactions in flight.
 *
 * Frenchy must not move the visitor while a signature is open. The wallet's
 * dialog belongs to the page that opened it: navigate underneath it and the
 * transaction lands with no receipt on screen, on a page that is no longer
 * there. So while a signature is pending, she speaks and *offers* the
 * destination instead of taking it.
 *
 * The count is global because the thing that must not move is the **page**,
 * and the pages that sign are many. A boolean per component would answer a
 * question nobody asks ("is this one button busy?"), and the question being
 * asked is "is anything being signed right now, anywhere".
 *
 * A counter rather than a flag, because two signatures can overlap: a visitor
 * can open a claim and a break in the same breath. The count never goes below
 * zero, so a stray release cannot make the site look idle while a signature
 * is open.
 */

let pending = 0;

/** A signature has been asked for. */
export function holdInteraction(): void {
  pending += 1;
}

/** A signature has been answered, or has failed. */
export function releaseInteraction(): void {
  pending = Math.max(0, pending - 1);
}

/** True while any signature is open. */
export function interactionPending(): boolean {
  return pending > 0;
}
