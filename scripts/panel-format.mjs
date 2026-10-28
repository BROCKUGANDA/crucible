export function percent(x, digits = 2) {
  return `${(x * 100).toFixed(digits)}%`;
}

/**
 * A count, its denominator, the rate and its 95% interval. A null rate means no probe was asked;
 * it prints as an em dash, never as 0%, which would be a measurement.
 */
export function countRate(count, n, rate, interval, digits = 1) {
  if (rate === null) return "— (no probe asked)";
  const ci = interval
    ? ` (95% CI ${percent(interval.low, digits)}–${percent(interval.high, digits)})`
    : "";
  return `${count}/${n} ${percent(rate, digits)}${ci}`;
}
