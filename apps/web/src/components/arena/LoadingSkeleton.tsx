"use client";

/**
 * LoadingSkeleton — a skeleton matching the shape of the actual content.
 *
 * Use only when the shape is known; otherwise Quenching (honest loading text)
 * is preferred. Skeletons must match the final layout to avoid layout shift.
 */
export function LoadingSkeleton({ rows = 4 }: { rows?: number }) {
  return (
    <div className="surface loading-skeleton" role="status" aria-label="Loading">
      {Array.from({ length: rows }).map((_, i) => (
        <div key={i} className="skeleton-row">
          <div className={`skeleton skeleton__line ${i % 3 === 0 ? "skeleton__short" : "skeleton__long"}`} />
          <div className="skeleton skeleton__line skeleton__long" />
        </div>
      ))}
    </div>
  );
}
