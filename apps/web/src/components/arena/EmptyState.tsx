"use client";

import Link from "next/link";
import type { ReactNode } from "react";

/**
 * EmptyState — an empty state with an honest label and a clear next action.
 *
 * Never a blank dashboard. Always tells the reader what the state means and
 * what to do next.
 */
export function EmptyState({
  line,
  cta,
  href,
  illustration,
}: {
  line: string;
  cta?: string;
  href?: string;
  illustration?: ReactNode;
}) {
  return (
    <div className="surface empty-state" role="region" aria-label="Empty state">
      {illustration ? <div className="empty-state__illustration">{illustration}</div> : null}
      <p className="empty-state__line">{line}</p>
      {cta && href ? (
        <Link className="btn btn-primary" href={href}>
          {cta}
        </Link>
      ) : null}
    </div>
  );
}
