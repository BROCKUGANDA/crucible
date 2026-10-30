"use client";

import { Chrome } from "@/components/Chrome";

export default function GhostRunPage() {
  return (
    <Chrome>
      <p className="kicker">Ghost run</p>
      <h1 className="page-title">A trial on a private fork</h1>
      <p className="hint hint--block">
        The fork host lands with P5 (Harena). The ArenaEvent envelope and frame reducer
        that render the run are shipped in <span className="mono">@crucible/arena-events</span>{" "}
        and <span className="mono">@crucible/frame</span>.
      </p>
    </Chrome>
  );
}
