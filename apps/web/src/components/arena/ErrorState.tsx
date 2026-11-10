"use client";

/**
 * ErrorState — an error state that explains what happened, whether data was
 * saved, what the user can do next, and whether retry is safe.
 */
export function ErrorState({
  title,
  message,
  retryable,
  onRetry,
}: {
  title: string;
  message: string;
  retryable?: boolean;
  onRetry?: () => void;
}) {
  return (
    <div className="surface error-state" role="alert" aria-label="Error">
      <h3 className="error-state__title" data-tone="sear">
        {title}
      </h3>
      <p className="error-state__message">{message}</p>
      {retryable && onRetry ? (
        <button type="button" className="btn btn-primary" onClick={onRetry}>
          Try again
        </button>
      ) : null}
    </div>
  );
}
