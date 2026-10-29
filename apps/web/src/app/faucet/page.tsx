"use client";

import { useEffect, useRef, useState } from "react";
import { Chrome } from "@/components/Chrome";
import { Modal } from "@/components/Modal";
import { SponsorshipGlyph } from "@/components/Glyphs";
import { API_BASE } from "@/lib/apiBase";
import { formatEth, shortHash } from "@/lib/forge";
import {
  countNewApplications,
  ownerStateFrom,
  readAllocations,
  readApplications,
  type AllocationRecord,
  type OwnerState,
  type SponsorshipApplication,
} from "@/lib/sponsorship";
import { useAccount } from "wagmi";

/**
 * Apply for test ETH from the funder - and, for the wallet that owns the
 * treasury, see who has applied.
 *
 * The funder dispenses test funds to a connected wallet; CRUCIBLE never holds
 * them and the escrow still settles in native ETH. On mainnet, sponsorship is
 * requested through the external application form instead.
 *
 * The applicant's side is the button below. The owner's side is the queue:
 * every application this host has seen, and what the treasury actually gave
 * out. Both are on this page because both are about the same faucet, and an
 * owner who has to go looking for "did anyone ask?" has not been notified.
 */

/**
 * How often the owner's queue is re-read while the page is open.
 */
const QUEUE_POLL_MS = 15_000;

/**
 * A moment, in UTC, in a form that does not depend on the reader's locale.
 *
 * The queue is a record of when things happened, and "14:03" without a zone is
 * a fact about nobody. ISO, cut to the second, is dull and unambiguous.
 */
function atTime(ms: number): string {
  if (!Number.isFinite(ms)) return "—";
  return `${new Date(ms).toISOString().slice(0, 19).replace("T", " ")} UTC`;
}

/** The one line an owner reads about an application. */
function outcomeLine(application: SponsorshipApplication): string {
  const asked = formatEth(application.requestedEth);
  if (application.outcome === "granted") {
    return `Granted ${formatEth(application.grantedEth)} of ${asked}.`;
  }
  if (application.outcome === "unanswered") {
    return `Nobody answered${application.reason ? `: ${application.reason}` : "."}`;
  }
  return `Refused${application.reason ? `: ${application.reason}` : "."}`;
}

export default function FaucetPage() {
  const { address, isConnected } = useAccount();
  const [amount, setAmount] = useState("0.1");
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);

  const [ownerState, setOwnerState] = useState<OwnerState>("unknown");
  const [queue, setQueue] = useState<SponsorshipApplication[] | null>(null);
  const [ledger, setLedger] = useState<AllocationRecord[] | null>(null);
  /** How many applications arrived since this page was opened. */
  const [unseen, setUnseen] = useState(0);
  /** The highest application id already counted, so only new ones count. */
  const seenUpTo = useRef<number | null>(null);

  const externalUrl = (process.env.NEXT_PUBLIC_SPONSORSHIP_URL ?? "").trim();

  /**
   * Read the owner's queue, and the treasury's ledger.
   *
   * The queue is polled rather than pushed: the API has no socket for it, and a
   * sponsor queue is not worth a websocket in the host. A failing poll says the
   * host could not answer - it never says the queue is empty, because "no
   * applications" and "cannot ask" are different facts and only one of them is
   * good news.
   */
  useEffect(() => {
    if (!address) {
      setOwnerState("unknown");
      setQueue(null);
      setLedger(null);
      return;
    }

    let alive = true;
    let inFlight: AbortController | null = null;

    const load = async () => {
      inFlight?.abort();
      const controller = new AbortController();
      inFlight = controller;

      let res: Response;
      try {
        res = await fetch(`${API_BASE}/faucet/applications?wallet=${address}`, {
          signal: controller.signal,
        });
      } catch (err) {
        // An aborted request is this poll being replaced by the next one, not
        // a failure of the host.
        if (!alive) return;
        if (err instanceof Error && err.name === "AbortError") return;
        setOwnerState("unavailable");
        return;
      }

      if (!alive) return;

      const state = ownerStateFrom(res.status);
      if (state !== "owner") {
        setOwnerState(state);
        if (state === "not-owner") setQueue(null);
        return;
      }

      const body = await res.json().catch(() => null);
      const applications = readApplications(body);
      if (!alive) return;
      if (!applications) {
        // The host said 200 and sent something that is not a queue. The panel
        // says it could not be read, because it was not.
        setOwnerState("unavailable");
        return;
      }

      setQueue(applications);
      setOwnerState("owner");

      // Only applications that arrived after the page was opened are "new":
      // a queue that was already full when the owner looked at it is history,
      // not a notification.
      const counted = countNewApplications(seenUpTo.current, applications);
      if (counted.unseen > 0) setUnseen((n) => n + counted.unseen);
      seenUpTo.current = counted.seenUpTo;

      // The ledger says what left the wallet with the test ETH. It is read
      // from the funder, and a funder that cannot be reached does not empty
      // the list - it says so.
      try {
        const ledgerRes = await fetch(`${API_BASE}/faucet/ledger?wallet=${address}`, {
          signal: controller.signal,
        });
        if (!alive || !ledgerRes.ok) return;
        const ledgerBody = await ledgerRes.json().catch(() => null);
        const allocations = readAllocations(ledgerBody);
        if (!alive || !allocations) return;
        setLedger(allocations);
      } catch {
        // The queue is the important half; the ledger is a second read and its
        // failure must not take the first one down.
      }
    };

    void load();
    const timer = setInterval(() => void load(), QUEUE_POLL_MS);

    return () => {
      alive = false;
      inFlight?.abort();
      clearInterval(timer);
    };
  }, [address]);

  async function confirmApply() {
    if (!address) return;
    setConfirming(false);
    setBusy(true);
    setError(null);
    setResult(null);
    try {
      const res = await fetch(`${API_BASE}/faucet`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ wallet: address, amountEth: Number(amount) }),
      });
      const body = (await res.json().catch(() => null)) as
        | { ok?: boolean; grantedEth?: string | null; reason?: string | null; fundable?: boolean }
        | null;
      if (res.ok && body?.ok) {
        setResult(
          body.grantedEth
            ? `Granted ${body.grantedEth} ETH. It is on its way to ${address}.`
            : "Request accepted.",
        );
      } else {
        setError(
          body?.reason ??
            (body?.fundable === false
              ? "No funder is configured on this host."
              : `The request was refused (${res.status}).`),
        );
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  function requestApply() {
    if (!address) {
      setError("Connect a wallet first — the request needs a destination address.");
      return;
    }
    setError(null);
    setResult(null);
    setConfirming(true);
  }

  return (
    <Chrome>
      <p className="kicker">Apply for ETH</p>
      <h1 className="page-title">
        <SponsorshipGlyph className="glyph--drop" /> Sponsorship of test ETH
      </h1>
      <p className="hint hint--block">
        Request test ETH for a connected wallet. The funder decides the amount and
        sends it to your own wallet; CRUCIBLE never holds it, and the escrow still
        settles in native ETH.
      </p>

      {ownerState === "owner" ? (
        <section className="surface detail-panel" aria-labelledby="owner-queue">
          <p className="kicker" id="owner-queue">
            Your treasury
          </p>
          <h2 className="page-title">Sponsorship requests</h2>

          {unseen > 0 ? (
            <p className="hint hint--block" role="status" data-tone="quench">
              {unseen === 1
                ? "One request arrived while this page was open."
                : `${unseen} requests arrived while this page was open.`}
            </p>
          ) : null}

          {queue === null ? (
            <p className="hint">Reading the queue…</p>
          ) : queue.length === 0 ? (
            <p className="hint">
              Nobody has applied yet. The queue is empty, not unreadable - this host
              answered.
            </p>
          ) : (
            <ul className="owner-queue">
              {queue.map((application) => (
                <li key={application.id} className="owner-queue__row">
                  <p className="kv">
                    <span className="kv__key">Wallet</span>
                    <span className="mono">{shortHash(application.wallet)}</span>
                  </p>
                  <p className="kv">
                    <span className="kv__key">Asked</span>
                    <span className="mono">{formatEth(application.requestedEth)}</span>
                  </p>
                  <p className="kv">
                    <span className="kv__key">Outcome</span>
                    <span
                      className={`badge badge--${
                        application.outcome === "granted"
                          ? "success"
                          : application.outcome === "refused"
                            ? "warning"
                            : "neutral"
                      }`}
                    >
                      {outcomeLine(application)}
                    </span>
                  </p>
                  <p className="kv">
                    <span className="kv__key">When</span>
                    <span className="mono">{atTime(application.at)}</span>
                  </p>
                </li>
              ))}
            </ul>
          )}

          <p className="kicker">What left the wallet with the test ETH</p>
          {ledger === null ? (
            <p className="hint">
              The treasury ledger could not be read. That is a fact about the funder,
              not an empty ledger.
            </p>
          ) : ledger.length === 0 ? (
            <p className="hint">Nothing has been handed out from this treasury.</p>
          ) : (
            <ul className="owner-queue">
              {ledger.map((allocation, index) => (
                <li key={`${allocation.at}-${index}`} className="owner-queue__row">
                  <p className="kv">
                    <span className="kv__key">Wallet</span>
                    <span className="mono">{shortHash(allocation.wallet)}</span>
                  </p>
                  <p className="kv">
                    <span className="kv__key">Granted</span>
                    <span className="mono">
                      {allocation.ok
                        ? formatEth(String(allocation.granted))
                        : "—"}
                    </span>
                  </p>
                  <p className="kv">
                    <span className="kv__key">When</span>
                    <span className="mono">{allocation.at}</span>
                  </p>
                </li>
              ))}
            </ul>
          )}
        </section>
      ) : null}

      {ownerState === "unavailable" ? (
        <p className="hint hint--block" role="status">
          This host could not answer the sponsorship queue. Nothing here says the
          queue is empty - it says the host did not answer.
        </p>
      ) : null}

      <div className="surface detail-panel">
        <label className="field">
          <span>Amount (ETH)</span>
          <input
            type="number"
            min="0"
            step="0.01"
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            disabled={busy}
          />
        </label>

        {isConnected && address ? (
          <p className="hint">Destination: {address}</p>
        ) : (
          <p className="hint" role="alert">
            Connect a wallet first.
          </p>
        )}

        <button
          type="button"
          className="btn btn-primary"
          onClick={requestApply}
          disabled={busy || !isConnected}
        >
          {busy ? "Requesting…" : "Apply for sponsorship"}
        </button>

        {result ? (
          <p className="hint" data-tone="quench" role="status">
            {result}
          </p>
        ) : null}
        {error ? (
          <p className="hint" data-tone="sear" role="alert">
            {error}
          </p>
        ) : null}
      </div>

      <Modal
        open={confirming}
        title="Apply for ETH sponsorship"
        onRequestClose={() => setConfirming(false)}
        busy={busy}
        actions={
          <>
            <button
              type="button"
              className="btn btn-ghost"
              onClick={() => setConfirming(false)}
              disabled={busy}
            >
              Cancel
            </button>
            <button
              type="button"
              className="btn btn-primary"
              onClick={confirmApply}
              disabled={busy}
            >
              {busy ? "Requesting…" : "Confirm"}
            </button>
          </>
        }
      >
        <p>
          Request {amount} ETH for {address}? The funder decides the final amount
          and sends it to your own wallet.
        </p>
      </Modal>

      {externalUrl ? (
        <p className="hint hint--block">
          On mainnet, sponsorship is requested through the application form:{" "}
          <a href={externalUrl} target="_blank" rel="noreferrer">
            Apply for ETH sponsorship
          </a>
          .
        </p>
      ) : null}
    </Chrome>
  );
}
