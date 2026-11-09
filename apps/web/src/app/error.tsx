"use client";

import { useEffect } from "react";
import { Crack } from "@/components/Crack";

/**
 * Route-level error boundary. The PRD calls for a full-crack vessel page rather
 * than a white screen — a judge clicking a bad link should see the forge, not a
 * stack trace or a browser default.
 *
 * The `digest` is Next's correlation id for this fault: it is the code an operator
 * can find in the server logs, so it is the one thing the panel shows the visitor
 * besides the message. A crash report without a code is a dead end; a code turns
 * "it crashed" into something that can be looked up.
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
      {error.digest ? (
        <p className="hint error-page__code">
          Fault code <span className="mono">{error.digest}</span> — send this if you report it.
        </p>
      ) : null}
      <div className="error-page__retry">
        <button className="btn btn-ghost" onClick={reset}>
          Try again
        </button>
      </div>
    </div>
  );
}
