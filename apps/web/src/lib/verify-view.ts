/**
 * What the verify page is actually able to claim about one token id.
 *
 * The page read `ownerOf` and `tokenURI` and printed `owner ? owner : "—"`. Four different
 * situations produce that em dash, and they are not four ways of saying the same thing:
 *
 *   - this build was compiled without a receipt address, so every query it makes goes to `0x0…`
 *     and the contract was never deployed here — the deployment's own
 *     `/.well-known/crucible.json` says `verificationReceipt: null`;
 *   - nobody has typed an id yet;
 *   - the chain has not answered;
 *   - the chain answered and refused, which is the only case that genuinely means *no such receipt*.
 *
 * The fourth is the one an integrator is sent here to establish, so collapsing it into the other
 * three makes the page unable to fail — and a trust surface that cannot say "no" cannot say "yes"
 * either. Kept as a pure mapping from the read's state to a view, in the style of `lib/ops.ts`,
 * because the distinction has to be testable against a fixture rather than against a wallet.
 */

/** The zero address: `NEXT_PUBLIC_VERIFICATION_RECEIPT_ADDRESS` unset resolves to this. */
export const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";

export type ReceiptView =
  | { kind: "idle"; detail: string }
  | { kind: "unconfigured"; detail: string }
  | { kind: "reading"; detail: string }
  // the chain answered and refused: no token with this id was ever minted
  | { kind: "absent"; detail: string }
  // the call could not be made, or its outcome is unknown: not a statement about the token
  | { kind: "unreachable"; detail: string }
  | {
      kind: "found";
      owner: string;
      uri: string | null;
      detail: string;
    };

export interface ReceiptRead {
  /** the address this build queries; the zero address means the wiring never happened */
  address: string;
  /** an id was entered and is well-formed */
  typed: boolean;
  /** a query is in flight and nothing has come back yet */
  reading: boolean;
  /** whatever wagmi reported; may be a viem error, a string, or absent */
  error?: unknown;
  owner?: string;
  uri?: string;
}

/**
 * Is this a revert the chain actually returned, or a failure to reach it?
 *
 * viem names the two differently (`ContractFunctionRevertedError` against `HttpRequestError` /
 * `ProviderRpcError` / a wallet rejection), and the difference is the whole point: one is an answer
 * about the token, the other is an answer about the connection. Anything unrecognised stays
 * `unreachable`, because "we do not know" is the safe reading of an unknown error — the page must
 * never tell an integrator a receipt does not exist on the strength of a socket.
 */
export function isRevert(error: unknown): boolean {
  if (!error) return false;
  const e = error as { name?: string; shortMessage?: string; message?: string; code?: number | string };
  const haystack = `${e.name ?? ""} ${e.shortMessage ?? ""} ${e.message ?? ""}`.toLowerCase();
  if (/contractfunctionreverted|revert|reverted/.test(haystack)) return true;
  if (/httprequesterror|provider|timed out|timeout|userrejected|not prepared|network/.test(haystack)) {
    return false;
  }
  // A revert carrying only a custom-error name still says so in the message.
  return /execution reverted|invalid token|does not exist|nonexistent/.test(haystack);
}

/** The state the page may print, from the state the read is in. */
export function receiptView(read: ReceiptRead): ReceiptView {
  if (!read.typed) {
    return { kind: "idle", detail: "Type a token id to ask the chain about it." };
  }

  if (read.address.toLowerCase() === ZERO_ADDRESS) {
    return {
      kind: "unconfigured",
      detail:
        "This deployment was built without a receipt address, so there is nothing to ask. The contract exists only where an operator wired it.",
    };
  }

  if (read.owner !== undefined && read.owner !== null) {
    return {
      kind: "found",
      owner: read.owner,
      uri: read.uri ?? null,
      detail: "The chain holds this receipt.",
    };
  }

  if (read.error) {
    return isRevert(read.error)
      ? {
          kind: "absent",
          detail: "The chain answered and refused this id: no receipt was minted for it here.",
        }
      : {
          kind: "unreachable",
          detail: "The chain could not be asked. This says nothing about whether the receipt exists.",
        };
  }

  if (read.reading) {
    return { kind: "reading", detail: "Reading the chain." };
  }

  return {
    kind: "unreachable",
    detail: "The call came back with nothing in it. That is not a finding about the token.",
  };
}
