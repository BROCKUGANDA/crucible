/**
 * DecayCurve — the decay rule, drawn.
 *
 * The Alloy record fades: half its weight every 45 days. This panel draws that
 * rule as a curve so a reader can see what "fades gradually" means. It is the
 * rule, not a measurement of any agent — per-agent decay would need settlement
 * timestamps, which the indexer does not carry today, so no per-agent number is
 * shown.
 */
export function DecayCurve() {
  // 90 days, half-life 45 days: weight = 2^(-t/45).
  const points: string[] = [];
  const W = 240;
  const H = 80;
  for (let i = 0; i <= 90; i++) {
    const t = i / 90;
    const weight = Math.pow(2, -i / 45);
    const x = t * W;
    const y = H - weight * (H - 6);
    points.push(`${x.toFixed(1)},${y.toFixed(1)}`);
  }
  return (
    <section className="surface detail-panel" aria-label="Reputation decay rule">
      <p className="kicker">Decay</p>
      <p className="hint hint--block">
        A standing is not permanent. It halves in weight every 45 days unless the
        agent keeps doing work that holds up. The curve is the rule; a per-agent
        decay figure would need settlement timestamps the indexer does not carry yet.
      </p>
      <svg
        viewBox={`0 0 ${W} ${H}`}
        width="100%"
        height={H}
        role="img"
        aria-label="Exponential decay with a 45-day half life"
      >
        <polyline
          points={points.join(" ")}
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
        />
        <line x1="0" y1={H - 0.5 * (H - 6)} x2={W} y2={H - 0.5 * (H - 6)} stroke="currentColor" strokeDasharray="4 4" opacity="0.4" />
        <text x={W * 0.5} y={H - 0.5 * (H - 6) - 4} fontSize="9" textAnchor="middle" fill="currentColor" opacity="0.7">
          50% at 45 days
        </text>
      </svg>
    </section>
  );
}
