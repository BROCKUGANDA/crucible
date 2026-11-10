"use client";

import { ColdForge } from "@/components/Chrome";

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
  illustration?: JSX.Element;
}) {
  return (
    <div className="surface empty-state" role="region" aria-label="Empty state">
      {illustration ? <div className="empty-state__illustration">{illustration}</div> : null}
      <p className="empty-state__line">{line}</p>
      {cta && href ? (
        <ColdForge line={line} cta={cta} href={href} />
      ) : null}
    </div>
  );
}
