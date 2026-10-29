import type { ApiSnapshot, ApiTrial } from "@crucible/indexer";
import { formatEth, shortCid, statusMeta } from "./forge";

/**
 * The one card on the landing page that stands between "what is this" and "open the board".
 *
 * It used to be a prop. `#42 · Summarise a receipt · 0.5 ETH · open · bond 0.05 ETH to play`,
 * baked into the prerendered HTML under the heading "Live on the board". None of it was read:
 * the board held trials 1-8, no trial is named anything — the chain stores a spec digest, not a
 * title — and 0.05 ETH was a rounded guess at a bond the contract computes as a fifth of the
 * reward. A visitor could not tell the one invented figure on the page from the six measured
 * ones beside it, which is the specific failure this repository was audited for.
 *
 * So the selection lives here, pure, rather than inside the component: a rule nobody can feed a
 * fixture is a rule that will report empty forever and look fine doing it. See `lib/ops.ts`.
 */

/** A trial a stranger can still claim. `assigned` is already taken; the card would lie about it. */
const CLAIMABLE = "open";

export type HeroBoard =
  | /** nothing was read yet, or the read failed — the card must not show a number */
    { kind: "unread" }
  | /** the board answered and no trial is open to claim */
    { kind: "empty" }
  | {
      kind: "trial";
      id: number;
      /** already truncated by `formatEth`; never re-rounded downstream */
      reward: string;
      bond: string;
      status: string;
      tone: ReturnType<typeof statusMeta>["tone"];
      spec: string;
      href: string;
    };

/**
 * The newest trial open to claim, as the hero card should print it.
 *
 * Ordered by id descending rather than trusting whatever order the index returned, so the card
 * shows the same trial on every reload of the same payload and the rule is testable against a
 * fixture instead of against a network.
 */
export function heroBoardFrom(snapshot: ApiSnapshot | null | undefined): HeroBoard {
  if (!snapshot || !Array.isArray(snapshot.trials)) return { kind: "unread" };

  const claimable = snapshot.trials
    .filter((t: ApiTrial) => t.status === CLAIMABLE)
    .sort((a, b) => b.id - a.id);

  const newest = claimable[0];
  if (!newest) return { kind: "empty" };

  const status = statusMeta(newest.status);
  return {
    kind: "trial",
    id: newest.id,
    reward: formatEth(newest.rewardEth),
    bond: formatEth(newest.bondEth),
    status: status.label,
    tone: status.tone,
    spec: newest.specCID ? `spec ${shortCid(newest.specCID)}` : "spec not disclosed yet",
    href: `/trials/${newest.id}`,
  };
}

/** The sentence the card ends with, kept here so a fixture can assert the unknown case too. */
export function heroBondLine(bond: string): string {
  return bond === "—" ? "bond —" : `bond ${bond} to claim`;
}
