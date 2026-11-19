import { Chrome } from "@/components/Chrome";
import { IssuerConsole } from "@/components/protocol/IssuerConsole";

/**
 * The issuer console — the private side of the STAMP register.
 *
 * It is not linked from the public navigation, and it is not protected by being
 * unlinked: the API authorises every call against the reviewer list, and this
 * page renders whatever that API says, including the refusal.
 */
export default function IssuerConsolePage() {
  return (
    <Chrome>
      <p className="kicker">Protocol ownership — private</p>
      <h1 className="page-title">Issuer console</h1>
      <p className="hint hint--block">
        The register behind the public projection: issuers, holders, instruments, the frozen Schedule 2 snapshot,
        observed payments, notices and the token structuring event. Every action here is a call the API already
        served to a reviewer — the page holds no key and grants no authority of its own.
      </p>
      <p className="hint hint--block">
        A wallet that is not on the reviewer list sees a refusal, not an empty register. A record this host has not
        measured prints as an em dash, never as a zero.
      </p>
      <IssuerConsole />
    </Chrome>
  );
}
