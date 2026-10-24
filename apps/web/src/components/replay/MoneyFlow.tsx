"use client";

import { shortCid, shortHash } from "@/lib/forge";
import { formatWei } from "@/lib/eth";
import { orDash, type FlowRow } from "@/lib/replay/view";

/**
 * The money this trial's own records carry: one line per movement, nothing else.
 *
 * What is deliberately absent is the point. There is no escrow total and no running balance on
 * this page, because the logs do not hold one — a verdict emits only the agent's payout, so where
 * a slash sent the reward and the break stake is not a number this page has. Summing the rows
 * would print a figure nobody sourced, and a reader has no way to tell that figure from a reading
 * of the chain. The footer says so, so the absence reads as a policy rather than an oversight.
 *
 * A figure is read or it is not shown: an amount the log does not carry prints an em dash, never
 * a `0`. Zero is a measurement — a paid-out-zero verdict really did pay nothing — and blanking it
 * would lose a fact.
 */

export interface MoneyFlowProps {
  rows: FlowRow[];
}

export function MoneyFlow({ rows }: MoneyFlowProps) {
  return (
    <div className="surface detail-panel">
      <h2 className="section-title section-title--tight">What moved</h2>

      {rows.length === 0 ? (
        <p className="hint hint--block">
          Nothing moved on the record this reader found — no prize entered escrow, no bond was
          taken, no verdict paid out.
        </p>
      ) : (
        rows.map((row) => (
          <div key={row.n} className="row">
            <span className="chip" data-tone={row.direction === "in" ? "ember" : "gold"}>
              {row.direction === "in" ? "in" : "out"}
            </span>
            <span data-tone="text">{row.movement}</span>
            <span className="mono figures">{figure(row.movedWei)}</span>
            {/* `mono`, not `kicker`: the kicker's uppercase tracking would print an address as
                0X976E…0AA9, and a checksum a reader cannot compare against a wallet is a checksum
                that has been broken by the stylesheet. `by —` is the dash rule doing its job: the
                record moved this amount and named nobody. */}
            <span className="mono">by {shortHash(row.who)}</span>
            {row.digest !== null ? (
              <span className="mono">proved by {shortCid(row.digest)}</span>
            ) : null}
          </div>
        ))
      )}

      <p className="hint hint--block">
        These are the amounts the chain recorded for this trial, beat by beat. There is no total
        here on purpose: the records this page reads do not carry an escrow balance, and adding one
        up would be arithmetic nobody sourced.
      </p>
    </div>
  );
}

/**
 * Wei -> the ETH figure a reader sees, through `weiToEth`, the one formatter in this repository
 * (see `src/lib/eth.ts`). Decimal strings and BigInt throughout: `Number(movedWei)` would put a
 * float on a path that ends in someone's payout.
 *
 * An unreadable string is reported as unread rather than as zero — the same refusal the rest of
 * the site makes with an em dash.
 */
function figure(wei: string | null): string {
  if (wei === null) return orDash(null);
  if (!/^\d+$/.test(wei)) return orDash(null);
  return `${formatWei(BigInt(wei))} ETH`;
}
