"use client";

import { useEffect } from "react";
import { Crack } from "@/components/Chrome";

/**
 * Route-level error boundary. The PRD calls for a full-crack vessel page rather
 * than a white screen — a judge clicking a bad link should see the forge, not a
 * stack trace or a browser default.
 */
export default function ErrorBoundary({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error(error);
  }, [error]);

  return (
    <div className="error-page">
      <Crack message={error.message} />
      <div className="error-page__retry">
        <button className="btn btn-ghost" onClick={reset}>
          Try again
        </button>
      </div>
    </div>
  );
}
