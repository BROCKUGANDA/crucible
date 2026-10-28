"use client";

import { useRef } from "react";
import { useScrubAct, useScrubSample } from "./context";
import { FRAME_COUNT } from "@/lib/scrub/timeline";

/**
 * The heads-up display. Same source of truth as the canvas, which is the whole trick of the
 * reference: the ruler, the counter and the drawing are three views of one number.
 *
 * The continuous parts are written imperatively — a CSS custom property for the rail and a
 * `textContent` swap for the counter — so a scroll tick never re-renders React. The discrete
 * act label does go through state, six times in the whole page, because it changes meaning.
 *
 * `style` attributes are absent on purpose: `setProperty` on an element reference is CSSOM,
 * which CSP does not police the way it polices inline markup. The app can therefore ship a
 * strict `style-src` while still having a ruler that moves.
 */
export function ScrubHud({
  trials,
  smiths,
  settled,
  lastBlock,
  feeRate,
  showCrowdKey,
}: {
  trials: number | null;
  smiths: number | null;
  settled: number | null;
  /** Block number of the newest settlement the index saw — not the chain head. */
  lastBlock: number | null;
  /**
   * The settlement fee as a rate ("5% · 500 bps"), read off the chain.
   *
   * Two ETH cells used to sit here — the protocol's cumulative fee and `credit[treasury]`. They
   * were removed on 2026-10-27 at the owner's request: an operator's takings are not the
   * visitor's business, and a landing page that advertises them invites the reader to price the
   * demo. The rate answers the question the cells were added for — whose money is this, and what
   * does it cost — without publishing a balance. `—` when the chain read has not landed; zero
   * would say the protocol charges nothing.
   */
  feeRate: string | null;
  /** Only when the crowd is actually being drawn from smiths, so the key never lies. */
  showCrowdKey: boolean;
}) {
  const railRef = useRef<HTMLDivElement | null>(null);
  const counterRef = useRef<HTMLSpanElement | null>(null);
  const act = useScrubAct();

  useScrubSample((sample) => {
    railRef.current?.style.setProperty("--p", sample.progress.toFixed(4));
    if (counterRef.current) {
      const text = `${String(sample.frame + 1).padStart(3, "0")} / ${FRAME_COUNT}`;
      if (counterRef.current.textContent !== text) counterRef.current.textContent = text;
    }
  });

  return (
    <div className="scrub-hud" data-act={act.key}>
      <div className="scrub-hud__rail" ref={railRef} aria-hidden="true">
        <span className="scrub-hud__fill" />
      </div>

      <p className="scrub-hud__counter mono" aria-hidden="true">
        <span>FR·</span>
        <span ref={counterRef}>001 / {FRAME_COUNT}</span>
      </p>

      <p className="scrub-hud__act" data-act={act.key}>
        <span className="scrub-hud__numeral roman">{act.numeral}</span>
        <span className="scrub-hud__label">{act.label}</span>
      </p>

      <dl className="scrub-hud__stats mono">
        <div>
          <dt>Posted</dt>
          <dd>{trials ?? "—"}</dd>
        </div>
        <div>
          <dt>Agents</dt>
          <dd>{smiths ?? "—"}</dd>
        </div>
        <div>
          <dt>Settled</dt>
          <dd>{settled ?? "—"}</dd>
        </div>
        <div>
          <dt>Latest</dt>
          <dd>{lastBlock ?? "—"}</dd>
        </div>
        <div title="What the chain charges to settle a paid trial — a rate, not anybody's balance">
          <dt>Fee</dt>
          <dd>{feeRate ?? "—"}</dd>
        </div>
      </dl>

      {showCrowdKey ? <p className="scrub-hud__key">Crowd · registered agents</p> : null}
    </div>
  );
}
