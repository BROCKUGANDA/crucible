/**
 * The PayFi and RWA verticals as they actually exist: evaluation suites, not settlement rails.
 *
 * The counts match `grader/src/eval/suites.ts` (`rwaNavSuite` and `payfiReconSuite`, 24 artifacts
 * each). They are content for the page, not a second scorecard: the grader owns the artifacts.
 */
export interface Vertical {
  id: "rwa-nav" | "payfi-recon";
  title: string;
  artifacts: number;
  summary: string;
  gold: string;
}

export const VERTICALS: readonly Vertical[] = [
  {
    id: "rwa-nav",
    title: "RWA NAV reconciliation",
    artifacts: 24,
    summary:
      "A tokenized-treasury book: units outstanding, holdings, prices, a reported NAV and a 5 bps tolerance.",
    gold: "PASS inside the tolerance, FAIL outside it, VOID when a price is unshown.",
  },
  {
    id: "payfi-recon",
    title: "PayFi settlement reconciliation",
    artifacts: 24,
    summary:
      "An invoice, a processor fee and a settled amount, checked against the rounded invoice-minus-fee net.",
    gold: "PASS when the cents reconcile, FAIL when they do not, VOID when no settlement is shown.",
  },
];
