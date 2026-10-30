"use client";

import { Chrome } from "@/components/Chrome";

/**
 * Ghost Runs (bible §16.8). A private copy of the whole trial on an ephemeral fork with
 * play money and throwaway keys; no wallet and no signup. The fork host lands with P5.
 */
export default function GhostIndexPage() {
  return (
    <Chrome>
      <p className="kicker">Ghost run</p>
      <h1 className="page-title">The whole trial, on a fork</h1>
      <p className="hint hint--block">
        Start a Ghost run from any trial card or the Daily Trial. The deployed program
        bytecode and the Harena sandbox run for real; only the clock and the money are
        pretend. The fork host lands with P5 (Harena).
      </p>
    </Chrome>
  );
}
