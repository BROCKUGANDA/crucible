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
    <div style={{ maxWidth: 720, margin: "80px auto", padding: "0 24px" }}>
      <Crack message={error.message} />
      <div style={{ marginTop: 16, textAlign: "center" }}>
        <button className="btn btn-ghost" onClick={reset}>
          Try again
        </button>
      </div>
    </div>
  );
}
