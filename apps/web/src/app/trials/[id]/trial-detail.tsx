"use client";

/**
 * The trial detail board, read from the snapshot stream in the browser.
 *
 * This was `page.tsx` until the 2026-10-29 audit's soft-404 finding. A route component that is
 * `"use client"` cannot answer an HTTP status: it renders the same document whatever the segment
 * says, so `/trials/abc` returned 200 with the "Lost slag." body inside it. The status decision
 * now lives in `./page.tsx`, a server component, which renders *this* component for the ids it
 * cannot disprove. See `src/lib/trial-id.ts` for exactly how much is knowable without a chain
 * read — and for the case that is still not: a well-formed id nobody has posted still paints the
 * panel below with a 200, because deciding that would mean reading the chain during a render.
 */

import Link from "next/link";
import { useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { Chrome, Quenching, SignalLost, TxLink, TxStates } from "@/components/Chrome";
import { TxSheetStatus } from "@/components/TxSheetStatus";
import { BreakPanel } from "@/components/BreakPanel";
import { MoneyTreesChip } from "@/components/MoneyTreesChip";
import { useSnapshot } from "@/lib/useSnapshot";
import {
  formatDuration,
  formatEth,
  shortHash,
  statusMeta,
  verdictMeta,
} from "@/lib/forge";
import { buildFinalize, useTx } from "@/lib/useTx";
import { useCountdown } from "@/lib/useSnapshot";
import { announceVoice } from "@/lib/voice";
import { celebrate } from "@/lib/sound-pref";

const TABS = ["The charge", "Struck work", "Break attempts", "The quench"] as const;

export function TrialDetail({ id }: { id: number }) {
  const { data, error, loading, chainNowMs } = useSnapshot();
  const trial = data?.trials.find((t) => t.id === id);

  const cools = useCountdown(trial?.deadlineAt ?? null, chainNowMs);
  const breakLeft = useCountdown(trial?.breakWindowEndsAt ?? null, chainNowMs);

  const [tab, setTab] = useState(0);
  const tabRefs = useRef<(HTMLButtonElement | null)[]>([]);
  const tx = useTx();
  const announcedFor = useRef<number | null>(null);

  // Frenchy speaks on a paid verdict, and only while the quench panel is on screen.
  // The visual is the trigger, not the transaction: the host is silent on a slash,
  // a refund, an error, a dispute, a form and a withdrawal.
  useEffect(() => {
    if (!trial || tab !== 3 || trial.verdict !== "paid") return;
    if (announcedFor.current === trial.id) return;
    announcedFor.current = trial.id;
    announceVoice("verdict");
    // The sound follows the same rule as the voice: this page saw a paid verdict, the visitor
    // switched audio on, and the motif is ours. Nothing here plays on a slash or a refund.
    celebrate();
  }, [trial, tab]);

  /** Quenchable: the skeptic window has closed, nothing was filed, and Argus holds
   * no dispute. Finalize is permissionless — whoever calls it moves none of their own
   * money — so this is a plain action, not a pour. */
  const quenchable =
    trial?.status === "judging" &&
    trial.breakWindowEndsAt !== null &&
    // `>=` is the contract's own boundary, not one second early: `finalize` reverts `WindowOpen`
    // while `block.timestamp < _windowEnd`, so the window is closed at exactly `_windowEnd`.
    // The anchor matters more than the operator here — a wall clock reads a warped chain as closed
    // while the node still holds the window open, and the button then offers a revert.
    (chainNowMs ?? Date.now()) / 1000 >= trial.breakWindowEndsAt;

  if (loading) {
    return (
      <Chrome>
        <Quenching label="reading this trial and its settlement from the chain…" />
      </Chrome>
    );
  }
  if (error) {
    return (
      <Chrome>
        <SignalLost message={error} />
      </Chrome>
    );
  }
  if (!trial) {
    return (
      <Chrome>
        <div className="surface void-panel">
          <h2 className="void-panel__title" data-tone="sear">
            Lost slag.
          </h2>
          <p className="void-panel__body">This page never left the crucible.</p>
          <Link className="btn btn-primary" href="/trials">
            Back to the forge
          </Link>
        </div>
      </Chrome>
    );
  }

  const status = statusMeta(trial.status);
  const verdict = verdictMeta(trial.verdict);

  /** APG tabs, selection-follows-focus: the arrow keys move the selected tab itself,
   * so one keystroke does the whole job for both pointer-less and sighted keyboard
   * operators. Arrow keys wrap, because a strip that dead-ends is a strip that
   * teaches people to stop using the keyboard. */
  function onTabKeyDown(e: KeyboardEvent<HTMLButtonElement>, i: number) {
    let next: number;
    if (e.key === "ArrowRight") next = (i + 1) % TABS.length;
    else if (e.key === "ArrowLeft") next = (i - 1 + TABS.length) % TABS.length;
    else if (e.key === "Home") next = 0;
    else if (e.key === "End") next = TABS.length - 1;
    else return;
    e.preventDefault();
    setTab(next);
    tabRefs.current[next]?.focus();
  }

  return (
    <Chrome>
      <p className="kicker">Trial {trial.id}</p>
      <h1 className="page-title trial-title">{formatEth(trial.rewardEth)} reward</h1>
      <span className="chip" data-tone={status.tone}>
        {status.label}
      </span>

      <div role="tablist" aria-label="Trial sections" className="trial-tabs">
        {TABS.map((t, i) => (
          <button
            key={t}
            ref={(el) => {
              tabRefs.current[i] = el;
            }}
            type="button"
            role="tab"
            id={`trial-tab-${t}`}
            aria-selected={i === tab}
            aria-controls={`trial-panel-${t}`}
            tabIndex={i === tab ? 0 : -1}
            className="trial-tabs__tab"
            data-active={i === tab || undefined}
            onClick={() => setTab(i)}
            onKeyDown={(e) => onTabKeyDown(e, i)}
          >
            {t}
          </button>
        ))}
      </div>

      {tab === 0 ? (
        <div
          role="tabpanel"
          id="trial-panel-The charge"
          aria-labelledby="trial-tab-The charge"
          className="surface detail-panel"
        >
          <Field label="Sponsor" value={trial.sponsor} mono />
          <Field label="Bond" value={formatEth(trial.bondEth)} mono />
          {/* The full address, not an abbreviation. This is the page a stranger arrives on to
              check a claim, and a truncated CID cannot be pasted into a gateway or compared
              against anything — the row in the list can stay short, this one has to be usable. */}
          <Field
            label="Suite"
            value={
              trial.testsCID
                ? <Pinned cid={trial.testsCID} />
                : `${shortHash(trial.testsDigest)} — fingerprint only`
            }
            mono
          />
          <Field
            label="Spec"
            value={
              trial.specCID
                ? <Pinned cid={trial.specCID} />
                : `${shortHash(trial.specDigest)} — fingerprint only`
            }
            mono
          />
          {/* This is the row a first-time reader cannot decode on their own, and the one place
              the whole "can this claim be checked?" promise visibly depends on it. The chain
              committed to a fingerprint of the spec and the test files at posting; the readable
              files live off-chain and only appear when the sponsor discloses them. Saying that
              out loud — and saying what it means for the work — is the honest answer, and it is
              the answer the docs already give. */}
          {trial.awaitingDisclosure ? (
            <p className="hint hint--block">
              What is pinned here is the <em>seal</em> on the spec and the tests — the exact
              files they describe have not been made readable on this site yet. Until they are,
              a checker holds the fingerprint but cannot re-run the work from it.
            </p>
          ) : null}
          <Field
            label="Countdown"
            value={
              trial.status === "judging" && breakLeft !== null
                ? `break window closes in ${formatDuration(breakLeft)}`
                : trial.status === "settled"
                  ? "settled"
                  : `submission deadline in ${formatDuration(cools)}`
            }
          />
        </div>
      ) : null}

      {tab === 1 ? (
        <div
          role="tabpanel"
          id="trial-panel-Struck work"
          aria-labelledby="trial-tab-Struck work"
          className="surface detail-panel"
        >
          {trial.operator ? (
            <Field label="Agent" value={trial.operator} mono />
          ) : null}
          {trial.runHash ? <Field label="Run" value={shortHash(trial.runHash)} mono /> : null}
          {!trial.operator && !trial.runHash ? (
            <p className="hint hint--block">
              Nothing on the anvil yet — no agent has claimed this trial.
            </p>
          ) : null}
        </div>
      ) : null}

      {tab === 2 ? (
        <div
          role="tabpanel"
          id="trial-panel-Break attempts"
          aria-labelledby="trial-tab-Break attempts"
        >
          {trial.status === "judging" ? (
            <BreakPanel trialId={trial.id} rewardEth={trial.rewardEth} bondEth={trial.bondEth} />
          ) : trial.breakSkeptic ? (
            <div className="surface detail-panel">
              <Field label="Skeptic" value={trial.breakSkeptic} mono />
              <Field label="Stake" value={formatEth(trial.breakStakeEth)} mono />
            </div>
          ) : (
            <p className="hint hint--block">
              No breaks filed. Skeptics can strike only while the trial is being judged.
            </p>
          )}
        </div>
      ) : null}

      {tab === 3 ? (
        <div
          role="tabpanel"
          id="trial-panel-The quench"
          aria-labelledby="trial-tab-The quench"
        >
          {trial.verdict !== "none" ? (
            <div className="surface verdict-panel" data-tone={verdict.tone}>
              <p className="verdict-panel__label">{verdict.label}</p>
              <p className="verdict-panel__why">
                {trial.verdict === "paid"
                  ? "Verified. The run survived every strike."
                  : trial.verdict === "slashed"
                    ? "Broken. The skeptic's proof held. Bond split: 30% to the skeptic, 70% to the treasury. Sponsor refunded."
                    : "Reclaimed. No run arrived before the deadline. The reward went home; the agent's bond went back."}
              </p>
              {/* Gate 434: the celebration is the paid verdict, so the chip asks for the paid
                  verdict. On a slash or a refund `settled` is false and it renders nothing. */}
              <MoneyTreesChip settled={trial.verdict === "paid"} />
            </div>
          ) : trial.status === "challenged" ? (
            <p className="hint hint--block">
              A break is under review — Argus holds the tongs until the committee's verdict.
            </p>
          ) : quenchable ? (
            <div className="surface detail-panel">
              <p className="verdict-panel__why">
                The skeptic window closed and nothing survived to challenge the claim. Anyone
                may quench now — the agent takes the reward, the bond stands, and the alloy
                mints. Quenching moves none of your own money.
              </p>
              <button
                type="button"
                className="btn btn-primary"
                disabled={tx.busy}
                aria-busy={tx.busy || undefined}
                onClick={() => tx.send(buildFinalize(trial.id))}
              >
                {tx.busy ? "Quenching…" : "Quench the trial"}
              </button>
              <TxStates state={tx.state} hash={tx.hash} message={tx.error} />
              <TxSheetStatus gasUsed={tx.gasUsed} gasWei={tx.gasWei} />
              {tx.state === "poured" && tx.hash ? (
                <p className="hint">
                  Quenched on-chain. The ledger catches up in a moment —{" "}
                  <TxLink hash={tx.hash} />.
                </p>
              ) : null}
            </div>
          ) : (
            <p className="hint hint--block">
              Not quenched yet.{" "}
              {trial.status === "judging" && breakLeft !== null
                ? `The skeptic window closes in ${formatDuration(breakLeft)} — quenching comes after.`
                : "The verdict lands once the skeptic window closes."}
            </p>
          )}
        </div>
      ) : null}
    </Chrome>
  );
}

function Field({ label, value, mono }: { label: string; value: ReactNode; mono?: boolean }) {
  return (
    <div className="kv">
      <span className="kv__key">{label}</span>
      <span className={mono ? "mono" : undefined}>{value}</span>
    </div>
  );
}

/**
 * A disclosed CID, and the bytes it names.
 *
 * The chain only ever held a keccak digest, and this host published the sha256 CID beside it.
 * Reading the file itself used to need the process that pinned it; `/content/:cid` serves it from
 * the store, so a stranger can check the claim against the suite rather than against a hash of it.
 *
 * The link opens the **viewer**, not the raw route. The route answers JSON for every failure, so a
 * visitor who clicked a hash used to land in a browser tab showing
 * `{"error":"the content store could not be read", ...}` with no explanation and no way back. The
 * viewer fetches the same route and says what happened, in words, in the product's own voice -
 * "not here" is not "broken here", and the distinction is the one a reader needs. The raw route
 * stays one click away for anyone who wants the bytes themselves.
 */
function Pinned({ cid }: { cid: string }) {
  return (
    <>
      <a href={`/content/${encodeURIComponent(cid)}`} className="mono">
        {cid}
      </a>{" "}
      <a href={`/content/${encodeURIComponent(cid)}`} rel="noreferrer">
        read what it names
      </a>
    </>
  );
}

