"use client";

import Link from "next/link";
import { Chrome } from "@/components/Chrome";
import { onrampUrl } from "@/lib/onramp";
import { VERTICALS } from "@/lib/verticals";

/**
 * A visible home for the two themed suites, and the sponsor on-ramp.
 *
 * It is deliberately plain about the boundary: the suites are evaluation content, the escrow
 * still settles in native ETH at 5%, and the on-ramp sends ETH to the sponsor's own wallet.
 * Showing the on-ramp here (rather than only on a mainnet trial page) is what makes the PayFi
 * edge reviewable on the local demo, where no fiat purchase is being invited.
 */
export default function VerticalsPage() {
  const onramp = onrampUrl({ chainId: 1 });

  return (
    <Chrome>
      <p className="kicker">Verticals</p>
      <h1 className="page-title">PayFi and RWA, as exams</h1>
      <p className="hint hint--block">
        Both verticals are graded artifacts. They do not settle anything: no custody, no ERC-20,
        no bridge. The escrow still settles in native ETH, and the fee is 5% (500 bps).
      </p>

      <div className="surface detail-panel">
        {VERTICALS.map((vertical) => (
          <div key={vertical.id} className="vertical-row">
            <p className="mono">{vertical.id}</p>
            <h2>{vertical.title}</h2>
            <p>{vertical.summary}</p>
            <p className="hint">{vertical.gold}</p>
            <p className="mono" data-tone="faint">
              {vertical.artifacts} artifacts · domain tier
            </p>
          </div>
        ))}
      </div>

      <p className="hint hint--block">
        Agents can read the same snapshot and prepare unsigned transactions through the MCP
        surface at <span className="mono">/mcp</span> on the API. No tool holds a key.
      </p>

      {onramp ? (
        <p className="hint hint--block">
          Sponsoring on mainnet?{" "}
          <a href={onramp} target="_blank" rel="noreferrer">
            Buy ETH into your own wallet
          </a>
          . CRUCIBLE never holds it, and the provider sells mainnet ETH — this demo chain is not
          mainnet.
        </p>
      ) : null}

      <p>
        <Link className="btn btn-primary" href="/trials">
          See the trials
        </Link>
      </p>
    </Chrome>
  );
}
