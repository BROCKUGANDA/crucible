import Link from "next/link";

/**
 * The warning that belongs at the button, not at the login screen.
 *
 * The demonstration notice existed, in plain words, on `/sign-in` — a page nobody has to pass
 * through to spend money. The two screens that actually open a wallet signature prompt, `/trials/new`
 * and `/forge`, carried no warning at all, and the word for the cost of sending a transaction
 * appeared nowhere on them. So the one reader who needed to be told the ETH is worthless and the
 * one who needed to be told the network still charges for the attempt both arrived at the signing
 * moment with neither sentence.
 *
 * Both are stated here, in the register the display rules require: no `Anvil`, no chain number, no
 * `wei`, and no estimate dressed up as a figure. This page does not ask the node what a write
 * costs, so it says that, and points at the number that is real — the one the wallet prints before
 * the signature is given.
 */
export function SigningNotice() {
  return (
    <div className="surface signing-notice">
      <p className="hint signing-notice__demo">
        <strong>This is a demonstration.</strong> The forge runs on a chain kept for showing it off,
        and the metal here is test ETH — worth nothing. You can still lose it: a trial posted is a
        trial escrowed, and a bond staked is a bond at risk until the work holds up.{" "}
        <Link href="/clock" data-tone="ember">
          See the rules the chain enforces
        </Link>
        .
      </p>
      <p className="hint signing-notice__gas">
        Every button on this page asks your wallet to sign a transaction, and the network charges
        gas for each one whether it succeeds or not. This page does not measure that cost — it does
        not ask the node — so it prints no number rather than an invented one. Your wallet shows
        the fee before you sign: <em>that</em> figure is the one to read, and a reverted attempt
        still pays it.
      </p>
    </div>
  );
}
