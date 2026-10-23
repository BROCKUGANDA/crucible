import type { ApiSnapshot } from "@crucible/indexer";

/**
 * The clock a chain deadline has to be measured against.
 *
 * Every deadline this product shows — `deadlineAt`, `breakWindowEndsAt` — is a claim about
 * `block.timestamp`, because that is what the contract compares against when a transaction
 * arrives. The API's `now` is the host's wall clock, and the two are the same only while nobody
 * warps the node. The demo warps it on purpose: the golden-path drill runs
 * `cast rpc anvil_setNextBlockTimestamp <now + 2 hours>` and then mines, so for the rest of that
 * chain's life the wall clock is two hours behind the time the contract enforces. Counting down
 * against the wall clock on a warped chain says a window is still open after it closed, and then
 * the quench button offers an action the contract answers with `WindowOpen`.
 *
 * The opposite error is just as bad and less obvious. On an idle instant-mining chain — this
 * deployment runs `anvil` with no `--block-time` — nothing is mined for hours, so `headTimestamp`
 * is the age of the last transaction rather than the present. Anchoring on it alone would report
 * a chain two days stale and hold every window open past its deadline.
 *
 * So the anchor is `max(headTimestamp + 1, wall clock)`, which is the rule a node applies to
 * stamp its next block: never before the previous one, never before real time.
 *
 * `null` when no snapshot has arrived. It is not zero — zero is the 1970s, and a countdown given
 * the 1970s reports every deadline as long gone.
 */
export function chainNowMs(
  snapshot: Pick<ApiSnapshot, "now" | "headTimestamp"> | null | undefined,
): number | null {
  if (!snapshot) return null;
  const { now, headTimestamp } = snapshot;
  if (headTimestamp === null || !Number.isFinite(headTimestamp)) return now;
  // Epoch seconds fit inside a double exactly with room to spare, so time does not need the
  // bigint treatment money does here.
  return Math.max(now, (headTimestamp + 1) * 1000);
}
