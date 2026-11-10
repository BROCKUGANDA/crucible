"use client";

/**
 * Pagination — cursor-based pagination controls.
 *
 * Shows a stable window label ("showing 50 of 137") and next/previous actions.
 * The parent supplies page info and onPageChange.
 */
export function Pagination({
  page,
  pageSize,
  total,
  hasMore,
  onPageChange,
}: {
  page: number;
  pageSize: number;
  total: number;
  hasMore: boolean;
  onPageChange: (nextPage: number) => void;
}) {
  const start = (page - 1) * pageSize + 1;
  const end = Math.min(page * pageSize, total);

  return (
    <nav className="pagination" aria-label="Pagination">
      <p className="pagination__label">
        Showing {start} of {total}{total > pageSize ? `, ${total - end} more behind` : ""}
      </p>
      {hasMore ? (
        <button
          type="button"
          className="btn btn-ghost"
          onClick={() => onPageChange(page + 1)}
          aria-label="Show more"
        >
          Show {Math.min(pageSize, total - end)} more
        </button>
      ) : null}
    </nav>
  );
}
