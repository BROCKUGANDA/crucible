import { Chrome } from "@/components/Chrome";
import { InvestorPortal } from "@/components/protocol/InvestorPortal";

/**
 * The investor portal — one holder, their own instruments, nothing else.
 *
 * The page cannot widen its own scope: the API resolves the holder from the
 * verified session and answers 404 for an instrument that belongs to someone
 * else, so an id in the URL would confirm nothing even if there were one.
 */
export default function InvestorPortalPage() {
  return (
    <Chrome>
      <p className="kicker">Protocol ownership — private</p>
      <h1 className="page-title">Investor portal</h1>
      <p className="hint hint--block">
        Your own instruments, the portion a frozen Schedule 2 snapshot gives you, the lock-up schedule once a
        delivery has been approved, and the delivery request itself. The portal shows what the register holds for
        your wallet — a record it cannot find prints as an em dash, never as zero.
      </p>
      <p className="hint hint--block">
        A delivery request is a signed offer to act. A reviewer approves it, the chain confirms the delivery, and
        only then does the lock-up schedule begin. No button on this page moves a token.
      </p>
      <InvestorPortal />
    </Chrome>
  );
}
