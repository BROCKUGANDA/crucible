"use client";

import { useEffect, useState } from "react";

/**
 * Toast — short action feedback. Auto-dismisses after a timeout.
 */
export function Toast({ message, variant = "info", timeout = 4000 }: { message: string; variant?: "info" | "success" | "error"; timeout?: number }) {
  const [visible, setVisible] = useState(true);

  useEffect(() => {
    const t = setTimeout(() => setVisible(false), timeout);
    return () => clearTimeout(t);
  }, [timeout]);

  if (!visible) return null;

  const tones: Record<string, string> = { info: "dim", success: "quench", error: "sear" };

  return (
    <div
      className="surface toast"
      role="status"
      aria-live="polite"
      aria-label={message}
      data-tone={tones[variant]}
    >
      <p className="toast__message">{message}</p>
    </div>
  );
}
