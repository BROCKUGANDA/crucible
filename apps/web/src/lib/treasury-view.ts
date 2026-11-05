export type TreasuryConnectionState =
  | "unconfigured"
  | "loading-address"
  | "unavailable-address"
  | "disconnected"
  | "wrong-wallet"
  | "treasury";

/**
 * The only wallet allowed to withdraw protocol credit is the exact address
 * returned by the deployed contract's treasury() getter.
 *
 * This is a presentation guard, not an authorization boundary: the contract's
 * msg.sender / credit mapping is the final on-chain authority.
 */
export function treasuryConnectionState(input: {
  configured: boolean;
  connectedAddress?: string;
  treasuryAddress?: string;
  treasuryLoading?: boolean;
  treasuryError?: boolean;
}): TreasuryConnectionState {
  if (!input.configured) return "unconfigured";
  if (!input.treasuryAddress) {
    return input.treasuryLoading ? "loading-address" : "unavailable-address";
  }
  if (input.treasuryError) return "unavailable-address";
  if (!input.connectedAddress) return "disconnected";
  return input.connectedAddress.toLowerCase() === input.treasuryAddress.toLowerCase()
    ? "treasury"
    : "wrong-wallet";
}
