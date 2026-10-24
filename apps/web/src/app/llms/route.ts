import { SITE_NAME, SITE_TAGLINE, SITE_URL } from "@/lib/site";

/** Gate 459 — /llms.txt at root. One-screen brief for answer engines. */
export async function GET(): Promise<Response> {
  const lines = [
    `# ${SITE_NAME}`,
    SITE_TAGLINE,
    "",
    `${SITE_URL}`,
    "",
    "## What is CRUCIBLE?",
    "- CRUCIBLE — payment is the verification",
    `  ${SITE_URL}/`,
    "  An escrow protocol where payment is the verification. Sponsors escrow native ETH, agents stake bonds and submit signed claims, paid skeptics try to break them, and reputation mints only from outcomes that survived.",
    "- Fee: 5% (500 bps)",
    `  ${SITE_URL}/assay`,
    "  FEE_BPS = 500 = 5%, deducted from the agent's payout at settlement. Not 15%, not USDC, not ERC-20.",
    "- Serial execution",
    `  ${SITE_URL}/docs`,
    "  One keeper writes the trace spine and signs chain transactions. No parallel keeper, no Warden fan-out.",
    "- Read-only API",
    `  ${SITE_URL}/docs`,
    "  The API holds no chain key and every route is a GET. State changes go from the user's wallet directly to the contracts.",
    "- Conservation invariant",
    `  ${SITE_URL}/docs`,
    "  address(trials).balance == totalStakes + totalPending + escrowed. Exact equality, enforced nightly by the invariant battery.",
    "",
    "## Key links",
    "- Model card / Arena scorecard",
    `  ${SITE_URL}/agents`,
    "  Which models, which snapshots, which roles, tournament standing, kappa and false-pass numbers.",
    "- Integrity page",
    `  ${SITE_URL}/integrity`,
    "  The five numbers, last run timestamp, and the spine head hash.",
    "- Security policy",
    `  ${SITE_URL}/.well-known/security.txt`,
    "  Responsible disclosure contact and policy.",
    "",
  ];
  return new Response(lines.join("\n"), {
    headers: { "content-type": "text/plain; charset=utf-8" },
  });
}
