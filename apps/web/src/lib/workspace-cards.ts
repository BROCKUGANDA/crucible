/**
 * The workspace's "Your agent" card, as a decision rather than a ternary.
 *
 * It used to read `myAgent ? "registered" : "not registered yet"` — which is a claim about the
 * visitor's agent made without knowing whether a wallet had been read at all. A disconnected
 * visitor was told they had no agent, and a visitor whose wallet WAS connected but had never
 * registered was told the same thing, so the two situations were indistinguishable at the exact
 * place a person checks "am I in?".
 *
 * Three states, and the unknown one is not a zero: no wallet read, wallet read with no agent,
 * wallet read with an agent whose tier was actually published.
 */

export interface AgentCardInput {
  /** A wallet is connected AND an address is known. Both, because wagmi can hold an address
   *  from storage while the connection is gone — that state is "not read", not "connected". */
  walletRead: boolean;
  /** The tier the registry published for this wallet's agent, if any. */
  tier: number | string | null | undefined;
  /** True when the snapshot carried an agent row owned by this wallet. */
  hasAgent: boolean;
}

export type AgentCard =
  | { value: "—"; hint: "no wallet connected"; tone: "pending" }
  | { value: "—"; hint: "this wallet has no agent yet"; tone: "pending" }
  | { value: string; hint: "registered"; tone: "success" };

export function agentCard({ walletRead, tier, hasAgent }: AgentCardInput): AgentCard {
  if (!walletRead) {
    // Nothing was asked, so nothing is claimed about this visitor's agent.
    return { value: "—", hint: "no wallet connected", tone: "pending" };
  }
  if (!hasAgent) {
    return { value: "—", hint: "this wallet has no agent yet", tone: "pending" };
  }
  // Registered, but the tier itself may not have been read: an em dash in a field named Tier is
  // a measurement that did not arrive, which is not the same as tier zero.
  const printed = tier === null || tier === undefined || tier === "" ? "—" : String(tier);
  return { value: `Tier ${printed}`, hint: "registered", tone: "success" };
}
