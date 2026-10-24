"use client";

import { Chrome } from "@/components/Chrome";
import { CLAIMS, type ClaimStatus } from "@/lib/claims/registry";

/**
 * The claim matrix, published.
 *
 * This page exists so the promises on the landing page can be read next to the thing that enforces
 * each one — including the rows that say a promise is ahead of the code. It is rendered from a
 * table whose `enforcedBy` paths are asserted to exist by `test/claims-registry.test.ts`, so a row
 * cannot keep an "enforced" label after the file that earned it has been deleted.
 */

const TONE: Record<ClaimStatus, string> = { enforced: "cool", partial: "gold", absent: "sear" };
const WORD: Record<ClaimStatus, string> = {
  enforced: "Enforced",
  partial: "Partly",
  absent: "Not yet",
};

export default function ClaimsPage() {
  const counts = CLAIMS.reduce(
    (acc, c) => ({ ...acc, [c.status]: (acc[c.status] ?? 0) + 1 }),
    {} as Record<string, number>,
  );

  return (
    <Chrome>
      <p className="kicker">The claims, and what stands behind them</p>
      <h1 className="page-title">Claim matrix</h1>
      <p className="lede">
        {counts.enforced ?? 0} of {CLAIMS.length} promises the site makes are enforced by code you
        can read at the path named below each one. {counts.absent ?? 0} are not enforced yet, and
        they are listed here rather than dropped from the page, because a list of only the kept
        promises is a marketing sheet.
      </p>
      <p className="hint hint--block">
        Every figure quoted here is the chain&apos;s own: an amount is a number a contract holds, a
        window is a constant it compares against, and a row that depends on a number this
        deployment does not measure says so instead of showing a score.
      </p>

      <div className="surface detail-panel">
        {CLAIMS.map((claim) => (
          <section key={claim.id} className="row" aria-label={`Claim ${claim.id}`}>
            <span className="chip" data-tone={TONE[claim.status]}>
              {WORD[claim.status]}
            </span>
            <span className="mono">{claim.id}</span>
            <span data-tone="text">“{claim.copy}”</span>
            <span className="hint hint--block">{claim.note}</span>
            {claim.enforcedBy.length > 0 ? (
              <ul className="stack" aria-label="Enforced by">
                {claim.enforcedBy.map((path) => (
                  <li key={path} className="mono">
                    {path}
                  </li>
                ))}
              </ul>
            ) : (
              <span className="hint">Nothing enforces this yet.</span>
            )}
          </section>
        ))}
      </div>
    </Chrome>
  );
}
