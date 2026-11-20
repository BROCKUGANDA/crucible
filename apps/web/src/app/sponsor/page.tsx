"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { Chrome, SignalLost } from "@/components/Chrome";
import { useAuthSession } from "@/lib/auth-session";
import {
  recordFundingClaim,
  useFundingStatus,
  useOrganisations,
  usePrograms,
  useSponsors,
  verifyFundingNow,
  type ConsoleState,
  type FundingStatus,
  type ProgramSummary,
} from "@/lib/useSponsorConsole";
import { formatWei, parseEth } from "@/lib/eth";

/**
 * The sponsor console — the money, and where it is.
 *
 * The one thing this page is built around: a sponsor's ledger and the
 * chain's escrow are two different things, and only one of them can be
 * checked. So the console shows BOTH — what the programme claims it
 * deposited, and what the escrow actually holds — and it labels a claim the
 * chain could not read as "not checked", never as "paid".
 *
 * Every amount here is wei from the API, formatted by the shared
 * `formatWei`, which never touches a float. An unknown amount prints as an
 * em dash: a claim the chain never confirmed has no amount.
 */
export default function SponsorConsolePage() {
  const auth = useAuthSession();
  const [orgId, setOrgId] = useState<string | null>(null);
  const [programId, setProgramId] = useState<string | null>(null);
  const [reloadToken, setReloadToken] = useState(0);

  const orgs = useOrganisations(auth.isAuthenticated);

  // "Your sponsors" means the sponsors whose wallet is the one that signed
  // in. The API owns membership; the console only knows which sponsor
  // record to ask about.
  const sponsors = useSponsors(auth.isAuthenticated);
  const mySponsor = useMemo(() => {
    if (sponsors.kind !== "ready" || !auth.address) return null;
    const address = auth.address.toLowerCase();
    return (
      sponsors.value.find(
        (sponsor) => sponsor.walletAddress?.toLowerCase() === address,
      ) ?? null
    );
  }, [sponsors, auth.address]);

  const programs = usePrograms(mySponsor?.id ?? null);

  const funding = useFundingStatus(programId, orgId, reloadToken);

  return (
    <Chrome>
      <p className="kicker">Sponsor console</p>
      <h1 className="page-title" id="sponsor-panel">Your programmes, and their money</h1>
      <p className="lede">
        Every programme has two ledgers: the one the platform keeps, and the
        escrow on the chain. This console shows both, and says when they
        disagree.
      </p>

      {!auth.isAuthenticated ? (
        <p className="surface detail-panel">
          <strong>Not signed in.</strong>
          <p className="hint">
            The console shows a wallet&apos;s own programmes. Connect and sign in to
            see yours; nothing here is public.
          </p>
        </p>
      ) : null}

      {auth.isAuthenticated ? (
        <>
          <h2 className="section-title">Which organisation</h2>
          <OrgChooser state={orgs} orgId={orgId} onPick={setOrgId} />

          <h2 className="section-title">Which programme</h2>
          {sponsors.kind === "loading" ? (
            <p className="hint">Reading the sponsors…</p>
          ) : sponsors.kind === "unreachable" ? (
            <SignalLost message={`The API could not be reached. (${sponsors.reason})`} />
          ) : sponsors.kind === "refused" ? (
            <SignalLost message={`The API refused the read. (${sponsors.reason})`} />
          ) : mySponsor === null ? (
            <p className="surface detail-panel hint">
              No sponsor record belongs to this wallet. A sponsor record is
              what a programme belongs to, so there is nothing to show until
              one exists for this address.
            </p>
          ) : (
            <>
              <p className="hint">
                Sponsor: <strong>{mySponsor.name}</strong> ({mySponsor.id})
              </p>
              <ProgramChooser state={programs} programId={programId} onPick={setProgramId} />
            </>
          )}

          {programId && mySponsor ? (
            <>
              <h2 className="section-title">Funding</h2>
              <FundingPanel
                programId={programId}
                orgId={orgId}
                sponsorAddress={mySponsor.walletAddress}
                state={funding}
                onChanged={() => setReloadToken((t) => t + 1)}
              />
            </>
          ) : null}
        </>
      ) : null}

      <p className="hint hint--block">
        Not a sponsor? The <Link className="mono" href="/developers">developer path</Link>{" "}
        and the <Link className="mono" href="/docs">written rules</Link> are the other
        doors in.
      </p>
    </Chrome>
  );
}

function OrgChooser({
  state,
  orgId,
  onPick,
}: {
  state: ConsoleState<{ id: string; name: string }[]>;
  orgId: string | null;
  onPick: (id: string) => void;
}) {
  if (state.kind === "loading") return <p className="hint">Reading your organisations…</p>;
  if (state.kind === "unreachable") {
    return <SignalLost message={`The API could not be reached. (${state.reason})`} />;
  }
  if (state.kind === "refused") {
    return <SignalLost message={`The API refused the read. (${state.reason})`} />;
  }
  if (state.value.length === 0) {
    return (
      <p className="surface detail-panel hint">
        You are not a member of any organisation yet. A programme belongs to an
        organisation, so one has to exist before there is anything to show.
      </p>
    );
  }
  return (
    <div className="stack">
      {state.value.map((org) => (
        <button
          key={org.id}
          type="button"
          className="surface detail-panel choice-panel"
          onClick={() => onPick(org.id)}
          aria-pressed={orgId === org.id}
        >
          <p>
            <strong>{org.name}</strong> {orgId === org.id ? "— selected" : ""}
          </p>
          <p className="mono hint">{org.id}</p>
        </button>
      ))}
    </div>
  );
}

function ProgramChooser({
  state,
  programId,
  onPick,
}: {
  state: ConsoleState<ProgramSummary[]>;
  programId: string | null;
  onPick: (id: string) => void;
}) {
  if (state.kind === "loading") return <p className="hint">Reading your programmes…</p>;
  if (state.kind === "unreachable") {
    return <SignalLost message={`The API could not be reached. (${state.reason})`} />;
  }
  if (state.kind === "refused") {
    return <SignalLost message={`The API refused the read. (${state.reason})`} />;
  }
  if (state.value.length === 0) {
    return (
      <p className="surface detail-panel hint">
        No programmes yet. A programme needs a sponsor, a budget and a
        publication policy before it can fund anything.
      </p>
    );
  }
  return (
    <div className="stack">
      {state.value.map((program) => (
        <button
          key={program.id}
          type="button"
          className="surface detail-panel choice-panel"
          onClick={() => onPick(program.id)}
          aria-pressed={programId === program.id}
        >
          <p>
            <strong>{program.name}</strong> {programId === program.id ? "— selected" : ""}
          </p>
          <p className="hint">Status: {program.status}</p>
        </button>
      ))}
    </div>
  );
}

function FundingPanel({
  programId,
  orgId,
  sponsorAddress,
  state,
  onChanged,
}: {
  programId: string;
  orgId: string | null;
  sponsorAddress: string;
  state: ConsoleState<FundingStatus>;
  onChanged: () => void;
}) {
  const [trialId, setTrialId] = useState("");
  const [amountEth, setAmountEth] = useState("");
  const [txHash, setTxHash] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  if (!orgId) {
    return (
      <p className="surface detail-panel hint">
        Choose an organisation first: a funding claim belongs to one, and the
        API checks that you are a member of it.
      </p>
    );
  }

  if (state.kind === "loading") return <p className="hint">Reading the escrow…</p>;
  if (state.kind === "unreachable") {
    return <SignalLost message={`The API could not be reached. (${state.reason})`} />;
  }
  if (state.kind === "refused") {
    return <SignalLost message={`The API refused the read. (${state.reason})`} />;
  }

  const { claims, receipts, summary } = state.value;
  const receiptFor = (claimId: string) => receipts.find((receipt) => receipt.claimId === claimId);

  async function submitClaim() {
    setBusy(true);
    setMessage(null);
    // The amount is parsed as a decimal string into wei. A float would put
    // the claim a few wei away from what the sponsor typed, and the chain
    // would refuse a claim that is off by those wei.
    const wei = parseEth(amountEth);
    if (wei === null) {
      setBusy(false);
      setMessage("The amount is not a plain number of ETH.");
      return;
    }
    const result = await recordFundingClaim({
      programId,
      orgId: orgId as string,
      trialId: trialId.trim(),
      sponsorAddress,
      claimedWei: wei.toString(),
      txHash: txHash.trim() || undefined,
    });
    setBusy(false);
    setMessage(
      result.ok
        ? "The claim was recorded and checked against the chain."
        : result.reason,
    );
    if (result.ok) {
      setTrialId("");
      setAmountEth("");
      setTxHash("");
      onChanged();
    }
  }

  async function verifyNow() {
    setBusy(true);
    setMessage(null);
    const result = await verifyFundingNow(programId, orgId as string);
    setBusy(false);
    setMessage(
      result.ok
        ? `Checked ${result.checked} claim(s) against the chain.`
        : result.reason,
    );
    if (result.ok) onChanged();
  }

  return (
    <>
      <div className="metric-grid">
        <p className="surface detail-panel">
          <strong>The escrow holds</strong>
          <br />
          {summary.verifiedWei === "0" && summary.verified === 0
            ? "—"
            : `${formatWei(BigInt(summary.verifiedWei))} ETH`}
          <br />
          <span className="hint">
            {summary.verified} of {summary.checked} claim(s) confirmed by the chain.
          </span>
        </p>
        <p className="surface detail-panel">
          <strong>The ledger claims</strong>
          <br />
          {summary.claimedWei === "0" && summary.checked === 0 ? "—" : `${formatWei(BigInt(summary.claimedWei))} ETH`}
          <br />
          <span className="hint">
            {summary.mismatched} contradicted, {summary.unverifiable} not checked.
          </span>
        </p>
      </div>

      <h3 className="section-title">Claims</h3>
      {claims.length === 0 ? (
        <p className="surface detail-panel hint">
          No funding claims yet. A claim says which trial a programme funded
          and how much — and it counts as nothing until the chain confirms it.
        </p>
      ) : (
        <div className="stack">
          {claims.map((claim) => {
            const receipt = receiptFor(claim.id);
            return (
              <div key={claim.id} className="surface detail-panel">
                <p>
                  Trial <span className="mono">{claim.trialId}</span> — claimed{" "}
                  {formatWei(BigInt(claim.claimedWei))} ETH
                </p>
                <p className="hint">
                  {receipt ? verdictLine(receipt.verdict) : "Not checked against the chain yet."}
                </p>
                {receipt?.observedSponsorFundingWei ? (
                  <p className="hint">
                    The escrow holds {formatWei(BigInt(receipt.observedSponsorFundingWei))} ETH
                    for this trial.
                  </p>
                ) : null}
                {receipt?.reason ? <p className="hint">{receipt.reason}</p> : null}
              </div>
            );
          })}
        </div>
      )}

      <h3 className="section-title">Record what you funded</h3>
      <p className="surface detail-panel">
        <p className="hint">
          A claim says which trial a programme funded and how much. It is
          checked against the chain the moment you record it, and it counts
          as nothing until the chain confirms it.
        </p>
        <label className="hint" htmlFor="claim-trial">
          Trial id
        </label>
        <input
          id="claim-trial"
          className="input"
          value={trialId}
          inputMode="numeric"
          onChange={(e) => setTrialId(e.target.value)}
          placeholder="1"
        />
        <label className="hint" htmlFor="claim-amount">
          Amount (ETH)
        </label>
        <input
          id="claim-amount"
          className="input"
          value={amountEth}
          inputMode="decimal"
          onChange={(e) => setAmountEth(e.target.value)}
          placeholder="1.15"
        />
        <label className="hint" htmlFor="claim-tx">
          Transaction hash (optional)
        </label>
        <input
          id="claim-tx"
          className="input mono"
          value={txHash}
          onChange={(e) => setTxHash(e.target.value)}
          placeholder="0x…"
        />
        <button
          type="button"
          className="btn btn-primary"
          onClick={submitClaim}
          disabled={busy || trialId.trim() === "" || amountEth.trim() === ""}
        >
          {busy ? "Recording…" : "Record the claim and check the chain"}
        </button>
      </p>

      <h3 className="section-title">Check again</h3>
      <p className="surface detail-panel">
        <p className="hint">
          The platform checks claims every ten minutes. You can ask it to check
          now — it reads the chain and writes down what it found.
        </p>
        <button type="button" className="btn btn-primary" onClick={verifyNow} disabled={busy}>
          {busy ? "Checking…" : "Check the chain now"}
        </button>
      </p>

      {message ? <p className="hint hint--block">{message}</p> : null}
    </>
  );
}

function verdictLine(verdict: string): string {
  if (verdict === "VERIFIED") return "Confirmed by the chain.";
  if (verdict === "MISMATCH") return "The chain says otherwise — this claim is contradicted.";
  return "The chain could not answer — this claim is not checked, not refused.";
}
