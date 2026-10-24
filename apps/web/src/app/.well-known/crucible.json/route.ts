import { SITE_NAME, SITE_URL } from "@/lib/site";

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

const ADDRESS = /^0x[0-9a-fA-F]{40}$/;

function published(value: string | undefined): string | null {
  return value && ADDRESS.test(value.trim()) ? value.trim() : null;
}

export function GET() {
  const trials = published(process.env.NEXT_PUBLIC_TRIALS_ADDRESS);
  const alloy = published(process.env.NEXT_PUBLIC_ALLOY_ADDRESS);

  const body = {
    product: SITE_NAME,
    site: SITE_URL,
    chain: {
      name: process.env.NEXT_PUBLIC_CHAIN ?? "foundry",
      chainId: Number(process.env.NEXT_PUBLIC_CHAIN_ID ?? 31337),
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
      credential: `records whose emitter is ${alloy ?? "(unset)"} — read tierOf(agentId), records(agentId) and locked(tokenId)`,
      settlement: `VerdictFinalized logs emitted by ${trials ?? "(unset)"}`,
      receipt: `VerificationReceiptMinted from the trials contract above; the receipt contract is trials.verificationReceipt()`,
    },
    caveats: [
      "This is a demonstration deployment on a local Anvil chain (id 31337). Nothing here is a financial or regulatory control.",
      "The addresses are baked at build time, so a redeploy to a new chain changes them; this file is regenerated with the deployment.",
      "A credential is one per agent. There is no identity epoch and no time-based decay in this deployment, so a record never starts over and never fades on its own — only a slashed outcome lowers it.",
    ],
  };

  return Response.json(body, {
    headers: { "cache-control": "public, max-age=3600" },
  });
}
