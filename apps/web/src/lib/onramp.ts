/**
 * A sponsor's fiat -> ETH on-ramp, provider-agnostic.
 *
 * The provider URL is configuration, not a constant: an unset or non-https value hides the link
 * rather than sending a sponsor somewhere this deployment has not configured. The provider sends
 * ETH to the sponsor's own wallet; CRUCIBLE never holds it, and the escrow still settles in
 * native ETH with FEE_BPS 500 (ADR-0001). There is no token and no bridge in this path.
 *
 * It is only meaningful on mainnet: a fiat provider sells mainnet ETH, so the caller renders it
 * only when the active chain id is 1. On the local demo it stays hidden.
 */
export interface OnrampTarget {
  address?: string | null;
  chainId: number;
}

export function onrampUrl(
  target: OnrampTarget,
  base = process.env.NEXT_PUBLIC_ONRAMP_URL,
): string | null {
  const raw = (base ?? "").trim();
  if (!raw) return null;

  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol !== "https:") return null;

  const address = (target.address ?? "").trim();
  if (/^0x[0-9a-fA-F]{40}$/.test(address)) url.searchParams.set("address", address);
  url.searchParams.set("chainId", String(target.chainId));
  return url.toString();
}
