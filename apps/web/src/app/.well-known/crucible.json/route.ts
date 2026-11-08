import { SITE_NAME, SITE_URL } from "@/lib/site";
import { activeChain, CHAIN_IDS, ZERO_ADDRESS, deployment } from "@/lib/networks";

/**
 * The published list of addresses CRUCIBLE's own records come from.
 *
 * The landing page says a credential no one can fake. Until this file existed that was an
 * assertion with nothing to check it against: a forged token from any other contract looks
 * identical to a real one to a reader who does not know which addresses mint it. So this route
 * answers the one question a third party actually has — which emitters are ours — and nothing
 * else. It is deliberately small: an allowlist that also carried scores would become a second
 * read model nobody keeps in sync.
 *
 * Addresses come from the same build-time `NEXT_PUBLIC_*` values the wallet is configured from,
 * so a deployment that forgot one publishes `null` for it rather than a zero address: a reader
 * who sees `0x0000…` would filter every real record out, and a missing value that reads as a
 * valid address is how an allowlist silently becomes a denylist.
 */

export function GET() {
  /**
   * Resolved through `deployment()` so this record reads the same per-network addresses
   * the wallet signs with — a mainnet build that publishes its generic fallback address
   * here while the site signs against `NEXT_PUBLIC_MAINNET_*` would publish an allowlist
   * for contracts that never emitted a record. Zero address means unset or malformed;
   * both publish as `null` (see the comment above).
   */
  const dep = deployment();
  const trials = dep.trials === ZERO_ADDRESS ? null : dep.trials;
  const alloy = dep.alloy === ZERO_ADDRESS ? null : dep.alloy;
  const chain = activeChain();

  const body = {
    product: SITE_NAME,
    site: SITE_URL,
    chain: {
      name: chain,
      chainId: CHAIN_IDS[chain],
    },
    contracts: {
      trials,
      alloy,
      /**
       * Not baked into the bundle, because the escrow holds it as a mutable field. A reader who
       * needs it asks the trials contract: `verificationReceipt()`. Publishing a guessed address
       * here would be worse than publishing none.
       */
      verificationReceipt: null,
    },
    /** How to tell a real record from a lookalike, in the order the checks have to run. */
    verify: {
      credential: `records whose emitter is ${alloy ?? "(unset)"} — read tierOf(agentId), records(agentId), epochOf(agentId), holderOf(agentId) and locked(tokenId)`,
      settlement: `VerdictFinalized logs emitted by ${trials ?? "(unset)"}`,
      receipt: `VerificationReceiptMinted from the trials contract above; the receipt contract is trials.verificationReceipt()`,
    },
    caveats: [
      /** The money sentence is network-honest: a mainnet record must not call itself a demo. */
      chain === "foundry"
        ? "This is a demonstration deployment on a local chain run by this deployment. The ETH there is worth nothing, and nothing here is a financial or regulatory control."
        : chain === "mainnet"
          ? "This deployment runs on Ethereum mainnet. Transactions move real value; nothing here is a financial or regulatory control."
          : "This deployment runs on the Sepolia test network. The ETH there is test ETH worth nothing, and nothing here is a financial or regulatory control.",
      "The addresses are baked at build time, so a redeploy to a new chain changes them; this file is regenerated with the deployment.",
      "A credential is one per agent and never moves. Its tier, wins, survivals and slashes are the CURRENT identity epoch's: when the ERC-8004 identity behind an agent is observed in new hands the window starts again (ADR-0012), while epoch, lifetimeWins and lifetimeSlashes do not — all four are in the credential's own tokenURI, so a reset reads as a reset without trusting this API.",
      "Standing also fades on the chain's clock: it loses half its weight after 45 days without work (standing_half_life_days: 45 in params/crucible.params.json), with the two operands this deployment does not measure (suite difficulty, sponsor independence) reported as assumptions rather than folded in.",
    ],
  };

  return Response.json(body, {
    headers: { "cache-control": "public, max-age=3600" },
  });
}
