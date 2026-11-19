"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { stampGet, stampPost, type StampResult } from "@/lib/protocol/client";
import {
  UNKNOWN,
  baseUnits,
  bps,
  isDenied,
  modeBanner,
  monthlyRows,
  shortDigest,
  vestingSummary,
  when,
  type VestingLike,
  type VestingStateLike,
} from "@/lib/protocol/console";

/**
 * The investor portal.
 *
 * One holder sees their own instruments and nothing else — the API answers 404,
 * not 403, for another holder's id, so this page cannot even confirm that a
 * record exists. The two numbers a holder needs are here: the portion from the
 * frozen snapshot, and what is still locked.
 *
 * A delivery request is an offer to act, not an action: it records the signed
 * request and the destination, and a reviewer still has to approve it. The page
 * says so instead of implying the tokens move when the button is pressed.
 */

interface Instrument {
  id: string;
  status: string;
  proRataBps: string;
  purchasePriceMinor: string;
  currency: string;
  signedDocumentSha256: string | null;
}

interface Expiration {
  expiresAt: number;
  basis: string;
  expired: boolean;
}

interface Portion {
  holderPortionTokens: string;
  priorDeliveredTokens: string;
  availableTokens: string;
}

interface Entry {
  instrument: Instrument;
  expiration: Expiration | null;
  vesting: VestingLike | null;
  portion: Portion | null;
}

interface VestingResponse {
  vesting: VestingLike;
  state: VestingStateLike;
}

type Flash = { tone: "cool" | "gold" | "sear"; text: string } | null;

export function InvestorPortal() {
  const [mode, setMode] = useState<string | null>(null);
  const [holderName, setHolderName] = useState<string | null>(null);
  const [entries, setEntries] = useState<Entry[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [states, setStates] = useState<Record<string, VestingStateLike>>({});
  const [denied, setDenied] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [flash, setFlash] = useState<Flash>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [destination, setDestination] = useState("");
  const [documentHash, setDocumentHash] = useState("");
  const [requestId, setRequestId] = useState("");
  const [challengeSignature, setChallengeSignature] = useState("");

  const handle = useCallback(<T,>(result: StampResult<T>, where: string): T | null => {
    if (result.ok) return result.data;
    if (isDenied(result.status)) setDenied(result.message);
    else setError(`${where}: ${result.message}`);
    return null;
  }, []);

  const load = useCallback(async () => {
    const ownership = await stampGet<{ mode: string }>("/stamp/protocol/ownership");
    if (ownership.ok) setMode(ownership.data.mode);
    else if (ownership.status === 404) setMode("disabled");

    const listed = await stampGet<{ holder: { displayName: string }; instruments: Entry[] }>(
      "/stamp/investor/instruments",
    );
    const data = handle(listed, "instruments");
    if (!data) return;
    setHolderName(data.holder.displayName);
    setEntries(data.instruments);
    setLoaded(true);

    // The schedule's released/locked split is a separate read; fetch it for the
    // instruments that have one rather than showing a total that never moves.
    const next: Record<string, VestingStateLike> = {};
    for (const entry of data.instruments) {
      if (!entry.vesting) continue;
      const state = await stampGet<VestingResponse>(`/stamp/investor/vesting/${entry.instrument.id}`);
      if (state.ok) next[entry.instrument.id] = state.data.state;
    }
    setStates(next);
  }, [handle]);

  useEffect(() => {
    void load();
  }, [load]);

  const run = useCallback(
    async (label: string, action: () => Promise<StampResult<unknown>>) => {
      setBusy(label);
      setError(null);
      setFlash(null);
      const result = await action();
      if (!result.ok) {
        if (isDenied(result.status)) setDenied(result.message);
        else setError(`${label}: ${result.message}`);
      } else {
        setFlash({ tone: "cool", text: `${label}: recorded — a reviewer still has to approve it` });
        await load();
      }
      setBusy(null);
    },
    [load],
  );

  const banner = useMemo(() => modeBanner(mode), [mode]);

  if (denied) {
    return (
      <div className="surface detail-panel" role="alert">
        <p className="kicker">Investor portal — no holder record</p>
        <p>{denied}</p>
        <p className="hint">
          The binding is made by a reviewer, not by connecting a wallet. If you are a holder and this is wrong, the
          issuer has to bind your wallet to your holder record first.
        </p>
      </div>
    );
  }

  return (
    <div className="stack">
      <p className="chip" data-tone={banner.tone}>
        {banner.title}
      </p>
      <p className="hint hint--block">{banner.body}</p>
      {error && (
        <p className="hint hint--block" role="alert">
          {error}
        </p>
      )}
      {flash && (
        <p className="hint hint--block" role="status">
          {flash.text}
        </p>
      )}

      {holderName && (
        <p className="hint">
          Holder: <strong>{holderName}</strong>
        </p>
      )}

      {!loaded ? (
        <div className="surface detail-panel">
          <p className="hint">
            This page has not read your instruments, so it cannot say whether any exist. Nothing is offered until the
            API answers.
          </p>
        </div>
      ) : entries.length === 0 ? (
        <div className="surface detail-panel">
          <p className="hint">
            No instruments are issued to this holder yet. Nothing is owed and nothing is locked — the absence of a
            record is not a zero balance.
          </p>
        </div>
      ) : (
        entries.map((entry) => {
          const state = states[entry.instrument.id];
          const summary = vestingSummary(entry.vesting, state);
          return (
            <section className="surface detail-panel" key={entry.instrument.id} aria-label="Instrument">
              <div className="row">
                <span className="chip" data-tone="gold">
                  {entry.instrument.status}
                </span>
                <span className="mono" title={entry.instrument.id}>
                  {shortDigest(entry.instrument.id)}
                </span>
                <span className="hint">
                  {entry.expiration
                    ? `expires ${when(entry.expiration.expiresAt)} (${entry.expiration.basis})${
                        entry.expiration.expired ? " — expired" : ""
                      }`
                    : "expiration not resolvable"}
                </span>
              </div>

              <div className="metric-grid">
                <p className="surface detail-panel">
                  <strong>Pro-rata</strong>
                  <span className="hint hint--block">{bps(entry.instrument.proRataBps)}</span>
                </p>
                <p className="surface detail-panel">
                  <strong>Purchase price</strong>
                  <span className="hint hint--block">
                    {baseUnits(entry.instrument.purchasePriceMinor)} {entry.instrument.currency}
                  </span>
                </p>
                <p className="surface detail-panel">
                  <strong>Portion (frozen)</strong>
                  <span className="hint hint--block">
                    {entry.portion ? baseUnits(entry.portion.holderPortionTokens) : UNKNOWN}
                  </span>
                </p>
                <p className="surface detail-panel">
                  <strong>Still deliverable</strong>
                  <span className="hint hint--block">
                    {entry.portion ? baseUnits(entry.portion.availableTokens) : UNKNOWN}
                  </span>
                </p>
              </div>

              <div className="row">
                <span className="hint">
                  Signature: {entry.instrument.signedDocumentSha256 ? "on file" : "not recorded"}
                </span>
              </div>

              {entry.vesting ? (
                <div className="stack">
                  <h3 className="kicker">Lock-up</h3>
                  <div className="metric-grid">
                    <p className="surface detail-panel">
                      <strong>Delivered</strong>
                      <span className="hint hint--block">{summary.delivered}</span>
                    </p>
                    <p className="surface detail-panel">
                      <strong>Released</strong>
                      <span className="hint hint--block">{summary.released}</span>
                    </p>
                    <p className="surface detail-panel">
                      <strong>Still locked</strong>
                      <span className="hint hint--block">{summary.locked}</span>
                    </p>
                    <p className="surface detail-panel">
                      <strong>Next release</strong>
                      <span className="hint hint--block">{summary.nextRelease}</span>
                    </p>
                  </div>
                  <p className="hint">
                    {summary.months} monthly releases · schedule conserved: {summary.conserved} · fully released:{" "}
                    {summary.complete}
                  </p>
                  <table className="table">
                    <thead>
                      <tr>
                        <th scope="col">#</th>
                        <th scope="col">Release</th>
                        <th scope="col">Amount (base units)</th>
                        <th scope="col">State</th>
                      </tr>
                    </thead>
                    <tbody>
                      {monthlyRows(entry.vesting, Date.now()).map((row) => (
                        <tr key={row.index}>
                          <td className="mono">{row.index}</td>
                          <td>{row.date}</td>
                          <td className="mono">{row.amount}</td>
                          <td>{row.released}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ) : (
                <p className="hint">No lock-up schedule exists yet: nothing has been delivered for this instrument.</p>
              )}

              <form
                className="stack"
                onSubmit={(e) => {
                  e.preventDefault();
                  void run("delivery request", () =>
                    stampPost(`/stamp/investor/instruments/${entry.instrument.id}/delivery-request`, {
                      destinationAddress: destination,
                      requestDocumentSha256: documentHash,
                      addressNetwork: "solana",
                    }),
                  );
                }}
              >
                <h3 className="kicker">Request delivery</h3>
                <p className="hint">
                  The request is signed and recorded; a reviewer approves it, and only then does a lock-up schedule
                  exist. Nothing moves on this button.
                </p>
                <div className="field">
                  <label htmlFor={`dest-${entry.instrument.id}`}>Destination Solana address</label>
                  <input
                    id={`dest-${entry.instrument.id}`}
                    className="input mono"
                    value={destination}
                    onChange={(e) => setDestination(e.target.value)}
                  />
                </div>
                <div className="field">
                  <label htmlFor={`doc-${entry.instrument.id}`}>Signed request SHA-256</label>
                  <input
                    id={`doc-${entry.instrument.id}`}
                    className="input mono"
                    value={documentHash}
                    onChange={(e) => setDocumentHash(e.target.value)}
                  />
                </div>
                <button
                  className="btn btn-primary"
                  type="submit"
                  disabled={
                    busy !== null ||
                    destination.trim() === "" ||
                    !/^[0-9a-f]{64}$/i.test(documentHash) ||
                    !["FUNDED", "ELIGIBLE_FOR_DELIVERY"].includes(entry.instrument.status)
                  }
                >
                  Submit delivery request
                </button>
              </form>
            </section>
          );
        })
      )}

      {loaded && entries.length > 0 && (
        <section className="surface detail-panel" aria-label="Address proof">
          <h2 className="section-title section-title--tight">Prove the destination address</h2>
          <p className="hint">
            After the request is recorded, sign a challenge with the destination wallet and paste it here. A reviewer
            cannot approve a delivery whose destination has not been proved.
          </p>
          <form
            className="stack"
            onSubmit={(e) => {
              e.preventDefault();
              void run("address proof", () =>
                stampPost(`/stamp/investor/delivery-request/${requestId}/address-proof`, {
                  challengeSignature,
                }),
              );
            }}
          >
            <div className="field">
              <label htmlFor="proof-request">Delivery request id</label>
              <input id="proof-request" className="input mono" value={requestId} onChange={(e) => setRequestId(e.target.value)} />
            </div>
            <div className="field">
              <label htmlFor="proof-signature">Challenge signature</label>
              <input
                id="proof-signature"
                className="input mono"
                value={challengeSignature}
                onChange={(e) => setChallengeSignature(e.target.value)}
              />
            </div>
            <button
              className="btn btn-sm"
              type="submit"
              disabled={busy !== null || requestId.trim() === "" || challengeSignature.trim() === ""}
            >
              Record proof
            </button>
          </form>
        </section>
      )}
    </div>
  );
}
