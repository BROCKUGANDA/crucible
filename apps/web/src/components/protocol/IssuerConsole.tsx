"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { stampGet, stampPost, type StampResult } from "@/lib/protocol/client";
import {
  UNKNOWN,
  baseUnits,
  bps,
  instrumentRows,
  isDenied,
  modeBanner,
  nextIssuerState,
  noticeRows,
  paymentRows,
  shortDigest,
  when,
  type InstrumentLike,
  type NoticeLike,
  type PaymentLike,
} from "@/lib/protocol/console";

/**
 * The issuer console.
 *
 * Everything here is a call the API already served; the console adds no
 * authority of its own. Two rules it keeps on the page:
 *
 *   - **A reviewer is the only caller.** A 401/403 becomes a panel that says
 *     which wallet is missing, not an empty table that reads like "no data".
 *   - **An action that the API will refuse is not offered as if it would work.**
 *     The mode banner says what this host may do; the delivery and structuring
 *     buttons stay visible because recording evidence is legitimate in manual
 *     review, and the refusal (when it comes) is shown in full.
 */

interface Issuer {
  id: string;
  legalEntityName: string;
  entityType: string;
  jurisdictionCode: string;
  status: string;
  createdAt: number;
}

interface Holder {
  id: string;
  displayName: string;
  partyType: string;
  eligibilityStatus: string;
  principalAddress: string | null;
}

interface Payment extends PaymentLike {
  refusalReason?: string | null;
}

interface NoticeSource extends NoticeLike {
  status: string;
}

interface AllocationSnapshot {
  holderId: string;
  effectiveProRataBps: string;
  holderPortionTokens: string;
}

interface AllocationResult {
  snapshots: AllocationSnapshot[];
  effectiveTotalBps: string;
  portionTotalTokens: string;
  capped: boolean;
  conserved: boolean;
  calculationInputHash: string;
}

interface StructuringEvent {
  id: string;
  status: string;
  totalNetworkTokens: string;
  tokenMint: string;
  finalityStatus: string;
}

interface AuditEvent {
  id: string;
  at: number;
  actor: string;
  action: string;
  detail: string;
}

interface ReconReport {
  instruments: { status: string; count: number }[];
  payments: { observed: number; verified: number; refused: number };
  reserve: { effectiveBps: string; capBps: string; headroomBps: string };
  notices: { outstanding: number; overdue: number };
  deliveryRequests: { open: number; approved: number; reconciled: number };
}

type Flash = { tone: "cool" | "gold" | "sear"; text: string } | null;

export function IssuerConsole() {
  const [mode, setMode] = useState<string | null>(null);
  const [issuers, setIssuers] = useState<Issuer[]>([]);
  const [issuerId, setIssuerId] = useState("");
  const [loaded, setLoaded] = useState(false);
  const [holders, setHolders] = useState<Holder[]>([]);
  const [instruments, setInstruments] = useState<InstrumentLike[]>([]);
  const [payments, setPayments] = useState<Payment[]>([]);
  const [notices, setNotices] = useState<NoticeSource[]>([]);
  const [snapshot, setSnapshot] = useState<AllocationResult | null>(null);
  const [event, setEvent] = useState<StructuringEvent | null>(null);
  const [report, setReport] = useState<ReconReport | null>(null);
  const [audit, setAudit] = useState<AuditEvent[]>([]);
  const [denied, setDenied] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [flash, setFlash] = useState<Flash>(null);

  const issuer = useMemo(() => issuers.find((i) => i.id === issuerId) ?? null, [issuers, issuerId]);

  const handle = useCallback(<T,>(result: StampResult<T>, where: string): T | null => {
    if (result.ok) return result.data;
    if (isDenied(result.status)) setDenied(result.message);
    else setError(`${where}: ${result.message}`);
    return null;
  }, []);

  const loadIssuers = useCallback(async () => {
    const ownership = await stampGet<{ mode: string }>("/stamp/protocol/ownership");
    if (ownership.ok) setMode(ownership.data.mode);
    else if (ownership.status === 404) setMode("disabled");
    const listed = await stampGet<{ issuers: Issuer[] }>("/stamp/admin/issuer");
    const data = handle(listed, "issuers");
    if (!data) return;
    setIssuers(data.issuers);
    setLoaded(true);
    if (!issuerId && data.issuers[0]) setIssuerId(data.issuers[0].id);
  }, [handle, issuerId]);

  const loadIssuerData = useCallback(
    async (id: string) => {
      const [h, i, p, n] = await Promise.all([
        stampGet<{ holders: Holder[] }>(`/stamp/admin/holders?issuer=${id}`),
        stampGet<{ instruments: InstrumentLike[] }>(`/stamp/admin/instruments?issuer=${id}`),
        stampGet<{ payments: Payment[] }>(`/stamp/admin/payments?issuer=${id}`),
        stampGet<{ notices: NoticeSource[] }>("/stamp/admin/notices"),
      ]);
      const holdersData = handle(h, "holders");
      const instrumentsData = handle(i, "instruments");
      const paymentsData = handle(p, "payments");
      const noticesData = handle(n, "notices");
      if (holdersData) setHolders(holdersData.holders);
      if (instrumentsData) setInstruments(instrumentsData.instruments);
      if (paymentsData) setPayments(paymentsData.payments);
      if (noticesData) setNotices(noticesData.notices);
    },
    [handle],
  );

  useEffect(() => {
    void loadIssuers();
  }, [loadIssuers]);

  useEffect(() => {
    if (issuerId) void loadIssuerData(issuerId);
  }, [issuerId, loadIssuerData]);

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
        setFlash({ tone: "cool", text: `${label}: recorded` });
        if (issuerId) await loadIssuerData(issuerId);
        await loadIssuers();
      }
      setBusy(null);
    },
    [issuerId, loadIssuerData, loadIssuers],
  );

  if (denied) {
    return (
      <div className="surface detail-panel" role="alert">
        <p className="kicker">Issuer console — no authority</p>
        <p>{denied}</p>
        <p className="hint">
          The reviewer list is configuration on the API host (<code className="mono">STAMP_REVIEWERS</code>). A
          wallet that is not on it can read the public projection at <code className="mono">/protocol</code> and
          nothing else.
        </p>
      </div>
    );
  }

  const banner = modeBanner(mode);
  const rows = instrumentRows(instruments, snapshot?.snapshots ?? []);

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

      <section className="surface detail-panel" aria-label="Issuer">
        <h2 className="section-title section-title--tight">Issuer</h2>
        {!loaded ? (
          <p className="hint">
            The issuer list has not been read, so this page cannot say whether an issuer exists. Nothing is offered
            until the API answers.
          </p>
        ) : issuers.length > 0 ? (
          <div className="field">
            <label htmlFor="issuer-select">Issuer</label>
            <select
              id="issuer-select"
              className="input"
              value={issuerId}
              onChange={(e) => setIssuerId(e.target.value)}
            >
              {issuers.map((i) => (
                <option key={i.id} value={i.id}>
                  {i.legalEntityName} — {i.id}
                </option>
              ))}
            </select>
          </div>
        ) : (
          <CreateIssuerForm busy={busy} run={run} />
        )}
        {issuer && (
          <div className="row">
            <span className="chip" data-tone="gold">
              {issuer.status}
            </span>
            <span className="hint">
              {issuer.entityType} · {issuer.jurisdictionCode} · created {when(issuer.createdAt)}
            </span>
            {nextIssuerState(issuer.status) && (
              <button
                className="btn btn-sm"
                disabled={busy !== null}
                onClick={() =>
                  run("advance issuer", () =>
                    stampPost("/stamp/admin/issuer/transition", {
                      issuerId: issuer.id,
                      to: nextIssuerState(issuer.status),
                    }),
                  )
                }
              >
                Advance to {nextIssuerState(issuer.status)}
              </button>
            )}
          </div>
        )}
      </section>

      {issuer && (
        <>
          <HoldersSection
            issuerId={issuer.id}
            holders={holders}
            busy={busy}
            run={run}
          />

          <InstrumentsSection
            issuerId={issuer.id}
            holders={holders}
            rows={rows}
            busy={busy}
            run={run}
          />

          <AllocationsSection
            issuerId={issuer.id}
            holders={holders}
            snapshot={snapshot}
            setSnapshot={setSnapshot}
            busy={busy}
            run={run}
          />

          <PaymentsSection
            issuerId={issuer.id}
            instruments={instruments}
            payments={payments}
            busy={busy}
            run={run}
          />

          <NoticesSection
            issuerId={issuer.id}
            notices={notices}
            busy={busy}
            run={run}
          />

          <StructuringSection
            issuerId={issuer.id}
            event={event}
            setEvent={setEvent}
            busy={busy}
            run={run}
          />

          <LedgerSection
            issuerId={issuer.id}
            report={report}
            setReport={setReport}
            audit={audit}
            setAudit={setAudit}
            busy={busy}
            setBusy={setBusy}
            setError={setError}
            setDenied={setDenied}
          />
        </>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Small pieces                                                         */
/* ------------------------------------------------------------------ */

type Run = (label: string, action: () => Promise<StampResult<unknown>>) => Promise<void>;

function CreateIssuerForm({ busy, run }: { busy: string | null; run: Run }) {
  const [legalEntityName, setName] = useState("");
  const [entityType, setType] = useState("corporation");
  const [jurisdictionCode, setJurisdiction] = useState("US-DE");
  return (
    <form
      className="stack"
      onSubmit={(e) => {
        e.preventDefault();
        void run("create issuer", () =>
          stampPost("/stamp/admin/issuer", { legalEntityName, entityType, jurisdictionCode }),
        );
      }}
    >
      <p className="hint">
        No issuer exists on this host yet. The issuer is the legal entity the STAMP instruments name; creating
        one starts the readiness ladder at DRAFT.
      </p>
      <div className="field">
        <label htmlFor="issuer-name">Legal entity name</label>
        <input
          id="issuer-name"
          className="input"
          value={legalEntityName}
          onChange={(e) => setName(e.target.value)}
          required
        />
      </div>
      <div className="field">
        <label htmlFor="issuer-type">Entity type</label>
        <input id="issuer-type" className="input" value={entityType} onChange={(e) => setType(e.target.value)} />
      </div>
      <div className="field">
        <label htmlFor="issuer-jurisdiction">Jurisdiction</label>
        <input
          id="issuer-jurisdiction"
          className="input"
          value={jurisdictionCode}
          onChange={(e) => setJurisdiction(e.target.value)}
        />
      </div>
      <button className="btn btn-primary" type="submit" disabled={busy !== null || legalEntityName.trim() === ""}>
        Create issuer
      </button>
    </form>
  );
}

function HoldersSection({
  issuerId,
  holders,
  busy,
  run,
}: {
  issuerId: string;
  holders: Holder[];
  busy: string | null;
  run: Run;
}) {
  const [displayName, setName] = useState("");
  const [partyType, setPartyType] = useState("investor");
  const [principal, setPrincipal] = useState("");
  return (
    <section className="surface detail-panel" aria-label="Holders">
      <h2 className="section-title section-title--tight">Holders</h2>
      {holders.length === 0 ? (
        <p className="hint">No holder records yet. An instrument names a holder, so this comes first.</p>
      ) : (
        <table className="table">
          <thead>
            <tr>
              <th scope="col">Holder</th>
              <th scope="col">Type</th>
              <th scope="col">Eligibility</th>
              <th scope="col">Bound wallet</th>
            </tr>
          </thead>
          <tbody>
            {holders.map((holder) => (
              <tr key={holder.id}>
                <td>{holder.displayName}</td>
                <td>{holder.partyType}</td>
                <td>{holder.eligibilityStatus}</td>
                <td className="mono">{holder.principalAddress ?? "not bound"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <form
        className="stack"
        onSubmit={(e) => {
          e.preventDefault();
          void run("create holder", () =>
            stampPost("/stamp/admin/holders", { issuerId, displayName, partyType }),
          );
        }}
      >
        <div className="field">
          <label htmlFor="holder-name">Display name</label>
          <input id="holder-name" className="input" value={displayName} onChange={(e) => setName(e.target.value)} required />
        </div>
        <div className="field">
          <label htmlFor="holder-type">Party type</label>
          <select id="holder-type" className="input" value={partyType} onChange={(e) => setPartyType(e.target.value)}>
            <option value="investor">investor</option>
            <option value="founder">founder</option>
            <option value="service-provider">service-provider</option>
          </select>
        </div>
        <button className="btn btn-sm" type="submit" disabled={busy !== null || displayName.trim() === ""}>
          Create holder
        </button>
      </form>
      <form
        className="stack"
        onSubmit={(e) => {
          e.preventDefault();
          const holder = holders.find((h) => h.displayName === principal) ?? holders[0];
          if (!holder) return;
          void run("bind holder", () =>
            stampPost("/stamp/admin/holders/bind", {
              holderId: holder.id,
              principalAddress: principal,
            }),
          );
        }}
      >
        <div className="field">
          <label htmlFor="holder-principal">Wallet to bind (the investor portal&apos;s only identity)</label>
          <input
            id="holder-principal"
            className="input mono"
            placeholder="0x…"
            value={principal}
            onChange={(e) => setPrincipal(e.target.value)}
          />
        </div>
        <p className="hint">
          The first holder in the list is bound. Wallet connection alone is not identity — this binding is what
          creates a portal.
        </p>
        <button
          className="btn btn-sm"
          type="submit"
          disabled={busy !== null || principal.trim() === "" || holders.length === 0}
        >
          Bind first holder to this wallet
        </button>
      </form>
    </section>
  );
}

function InstrumentsSection({
  issuerId,
  holders,
  rows,
  busy,
  run,
}: {
  issuerId: string;
  holders: Holder[];
  rows: ReturnType<typeof instrumentRows>;
  busy: string | null;
  run: Run;
}) {
  const [holderId, setHolderId] = useState("");
  const [documentSha256, setDocHash] = useState("");
  const [documentUri, setDocUri] = useState("");
  const [purchasePriceMinor, setPrice] = useState("");
  const [acceptedStablecoinMint, setMint] = useState("");
  const [approvedWallet, setWallet] = useState("");
  const [proRataBps, setProRata] = useState("");
  const [signatureHash, setSignatureHash] = useState("");

  return (
    <section className="surface detail-panel" aria-label="Instruments">
      <h2 className="section-title section-title--tight">Instruments</h2>
      {rows.length === 0 ? (
        <p className="hint">No instruments yet.</p>
      ) : (
        <table className="table">
          <thead>
            <tr>
              <th scope="col">Instrument</th>
              <th scope="col">Status</th>
              <th scope="col">Pro-rata</th>
              <th scope="col">Price</th>
              <th scope="col">Portion</th>
              <th scope="col">Signature</th>
              <th scope="col">Actions</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => {
              return (
                <tr key={row.id}>
                  <td className="mono" title={row.id}>
                    {shortDigest(row.id)}
                  </td>
                  <td>
                    <span className="chip" data-tone={row.tone}>
                      {row.status}
                    </span>
                  </td>
                  <td>{row.proRata}</td>
                  <td>{row.price}</td>
                  <td className="mono">{row.portion}</td>
                  <td>{row.signed}</td>
                  <td className="row">
                    <button
                      className="btn btn-sm"
                      disabled={busy !== null}
                      onClick={() =>
                        run("approve instrument", () =>
                          stampPost(`/stamp/admin/instruments/${row.id}/approve`, {}),
                        )
                      }
                    >
                      Approve
                    </button>
                    <button
                      className="btn btn-sm"
                      disabled={busy !== null}
                      onClick={() =>
                        run("offer instrument", () =>
                          stampPost(`/stamp/admin/instruments/${row.id}/transition`, { to: "OFFERED" }),
                        )
                      }
                    >
                      Offer
                    </button>
                    <button
                      className="btn btn-sm"
                      disabled={busy !== null || !/^[0-9a-f]{64}$/i.test(signatureHash)}
                      onClick={() =>
                        run("record signature", () =>
                          stampPost(`/stamp/admin/instruments/${row.id}/record-signature`, {
                            signedDocumentSha256: signatureHash,
                          }),
                        )
                      }
                    >
                      Record signature
                    </button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
      <div className="field">
        <label htmlFor="signature-hash">Signed document SHA-256 (used by every “Record signature” button)</label>
        <input
          id="signature-hash"
          className="input mono"
          value={signatureHash}
          onChange={(e) => setSignatureHash(e.target.value)}
        />
      </div>
      <form
        className="stack"
        onSubmit={(e) => {
          e.preventDefault();
          void run("create instrument", () =>
            stampPost("/stamp/admin/instruments", {
              issuerId,
              holderPartyId: holderId || holders[0]?.id,
              documentSha256,
              documentUri,
              issueDate: Date.now(),
              purchasePriceMinor,
              acceptedStablecoinMint,
              approvedWallet,
              proRataBps,
            }),
          );
        }}
      >
        <h3 className="kicker">New instrument (draft)</h3>
        <div className="field">
          <label htmlFor="instrument-holder">Holder</label>
          <select
            id="instrument-holder"
            className="input"
            value={holderId}
            onChange={(e) => setHolderId(e.target.value)}
          >
            {holders.map((h) => (
              <option key={h.id} value={h.id}>
                {h.displayName}
              </option>
            ))}
          </select>
        </div>
        <div className="field">
          <label htmlFor="instrument-doc">Document SHA-256</label>
          <input id="instrument-doc" className="input mono" value={documentSha256} onChange={(e) => setDocHash(e.target.value)} />
        </div>
        <div className="field">
          <label htmlFor="instrument-uri">Document URI (private store)</label>
          <input id="instrument-uri" className="input mono" value={documentUri} onChange={(e) => setDocUri(e.target.value)} />
        </div>
        <div className="field">
          <label htmlFor="instrument-price">Purchase price, minor units</label>
          <input id="instrument-price" className="input mono" value={purchasePriceMinor} onChange={(e) => setPrice(e.target.value)} />
        </div>
        <div className="field">
          <label htmlFor="instrument-mint">Accepted stablecoin mint</label>
          <input id="instrument-mint" className="input mono" value={acceptedStablecoinMint} onChange={(e) => setMint(e.target.value)} />
        </div>
        <div className="field">
          <label htmlFor="instrument-wallet">Approved receipt wallet</label>
          <input id="instrument-wallet" className="input mono" value={approvedWallet} onChange={(e) => setWallet(e.target.value)} />
        </div>
        <div className="field">
          <label htmlFor="instrument-bps">Schedule 2 pro-rata, basis points</label>
          <input id="instrument-bps" className="input mono" value={proRataBps} onChange={(e) => setProRata(e.target.value)} />
        </div>
        <button
          className="btn btn-primary"
          type="submit"
          disabled={
            busy !== null ||
            holders.length === 0 ||
            !/^[0-9a-f]{64}$/i.test(documentSha256) ||
            !/^[0-9]+$/.test(purchasePriceMinor) ||
            !/^[0-9]+$/.test(proRataBps)
          }
        >
          Create draft instrument
        </button>
      </form>
    </section>
  );
}

function AllocationsSection({
  issuerId,
  holders,
  snapshot,
  setSnapshot,
  busy,
  run,
}: {
  issuerId: string;
  holders: Holder[];
  snapshot: AllocationResult | null;
  setSnapshot: (value: AllocationResult | null) => void;
  busy: string | null;
  run: Run;
}) {
  const [totalNetworkTokens, setTotal] = useState("");
  const [rates, setRates] = useState<Record<string, string>>({});
  return (
    <section className="surface detail-panel" aria-label="Schedule 2">
      <h2 className="section-title section-title--tight">Schedule 2 — the frozen snapshot</h2>
      <p className="hint">
        The cap is an aggregate rule, so the snapshot is computed for every holder at once. A snapshot is
        immutable: a correction is a new calculation, never an edit.
      </p>
      <form
        className="stack"
        onSubmit={(e) => {
          e.preventDefault();
          const entries = holders
            .map((h) => ({ holderId: h.id, proRataBps: (rates[h.id] ?? "").trim() }))
            .filter((entry) => /^[0-9]+$/.test(entry.proRataBps) && entry.proRataBps !== "0");
          void (async () => {
            const result = await stampPost<AllocationResult>("/stamp/admin/allocations", {
              issuerId,
              totalNetworkTokens,
              holders: entries,
            });
            if (result.ok) {
              setSnapshot(result.data);
              await run("calculate allocations", () => Promise.resolve(result));
            } else {
              await run("calculate allocations", () => Promise.resolve(result));
            }
          })();
        }}
      >
        <div className="field">
          <label htmlFor="alloc-total">Total network tokens (base units)</label>
          <input id="alloc-total" className="input mono" value={totalNetworkTokens} onChange={(e) => setTotal(e.target.value)} />
        </div>
        {holders.map((holder) => (
          <div className="field" key={holder.id}>
            <label htmlFor={`alloc-${holder.id}`}>{holder.displayName} — raw pro-rata, bps</label>
            <input
              id={`alloc-${holder.id}`}
              className="input mono"
              value={rates[holder.id] ?? ""}
              onChange={(e) => setRates({ ...rates, [holder.id]: e.target.value })}
            />
          </div>
        ))}
        <button className="btn btn-primary" type="submit" disabled={busy !== null || !/^[0-9]+$/.test(totalNetworkTokens)}>
          Calculate and freeze
        </button>
      </form>
      {snapshot && (
        <div className="stack">
          <p className="hint">
            Effective total {bps(snapshot.effectiveTotalBps)} · portion total {baseUnits(snapshot.portionTotalTokens)} ·
            {snapshot.capped ? " cap applied" : " under the cap"} · {snapshot.conserved ? "conserved" : "NOT conserved"}
          </p>
          <table className="table">
            <thead>
              <tr>
                <th scope="col">Holder</th>
                <th scope="col">Effective</th>
                <th scope="col">Portion (base units)</th>
              </tr>
            </thead>
            <tbody>
              {snapshot.snapshots.map((row) => (
                <tr key={row.holderId}>
                  <td className="mono">{row.holderId}</td>
                  <td>{bps(row.effectiveProRataBps)}</td>
                  <td className="mono">{baseUnits(row.holderPortionTokens)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="hint mono">input hash {shortDigest(snapshot.calculationInputHash)}</p>
        </div>
      )}
    </section>
  );
}

function PaymentsSection({
  issuerId,
  instruments,
  payments,
  busy,
  run,
}: {
  issuerId: string;
  instruments: InstrumentLike[];
  payments: Payment[];
  busy: string | null;
  run: Run;
}) {
  const [instrumentId, setInstrumentId] = useState("");
  const [cluster, setCluster] = useState("devnet");
  const [tokenMint, setMint] = useState("");
  const [fromAddress, setFrom] = useState("");
  const [toApproved, setTo] = useState("");
  const [amountBaseUnits, setAmount] = useState("");
  const [signature, setSignature] = useState("");
  const [finalityStatus, setFinality] = useState("finalized");
  const [canonicalityStatus, setCanonical] = useState("canonical");
  const rows = paymentRows(payments);

  return (
    <section className="surface detail-panel" aria-label="Payments">
      <h2 className="section-title section-title--tight">Payments</h2>
      <p className="hint">
        A payment is a chain observation, never a screenshot. Verification compares the mint, the network, the
        wallet and the exact amount with the signed instrument.
      </p>
      {rows.length === 0 ? (
        <p className="hint">Nothing observed yet.</p>
      ) : (
        <table className="table">
          <thead>
            <tr>
              <th scope="col">Payment</th>
              <th scope="col">Instrument</th>
              <th scope="col">Amount</th>
              <th scope="col">Finality</th>
              <th scope="col">Canonical</th>
              <th scope="col">State</th>
              <th scope="col" />
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.id}>
                <td className="mono">{shortDigest(row.id)}</td>
                <td className="mono">{shortDigest(row.instrument)}</td>
                <td className="mono">{row.amount}</td>
                <td>{row.finality}</td>
                <td>{row.canonical}</td>
                <td>
                  <span className="chip" data-tone={row.tone}>
                    {row.state}
                  </span>
                </td>
                <td>
                  <button
                    className="btn btn-sm"
                    disabled={busy !== null || row.state === "verified"}
                    onClick={() => run("verify payment", () => stampPost(`/stamp/admin/payments/${row.id}/verify`, {}))}
                  >
                    Verify
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <form
        className="stack"
        onSubmit={(e) => {
          e.preventDefault();
          void run("observe payment", () =>
            stampPost("/stamp/admin/payments/observe", {
              instrumentId: instrumentId || instruments[0]?.id,
              cluster,
              tokenMint,
              fromAddress,
              toApproved,
              amountBaseUnits,
              signature,
              finalityStatus,
              canonicalityStatus,
            }),
          );
        }}
      >
        <h3 className="kicker">Observe a payment</h3>
        <div className="field">
          <label htmlFor="payment-instrument">Instrument</label>
          <select
            id="payment-instrument"
            className="input"
            value={instrumentId}
            onChange={(e) => setInstrumentId(e.target.value)}
          >
            {instruments.map((i) => (
              <option key={i.id} value={i.id}>
                {shortDigest(i.id)} — {i.status}
              </option>
            ))}
          </select>
        </div>
        <div className="field">
          <label htmlFor="payment-cluster">Cluster</label>
          <input id="payment-cluster" className="input" value={cluster} onChange={(e) => setCluster(e.target.value)} />
        </div>
        <div className="field">
          <label htmlFor="payment-mint">Token mint</label>
          <input id="payment-mint" className="input mono" value={tokenMint} onChange={(e) => setMint(e.target.value)} />
        </div>
        <div className="field">
          <label htmlFor="payment-from">From address</label>
          <input id="payment-from" className="input mono" value={fromAddress} onChange={(e) => setFrom(e.target.value)} />
        </div>
        <div className="field">
          <label htmlFor="payment-to">To the instrument&apos;s approved wallet</label>
          <input id="payment-to" className="input mono" value={toApproved} onChange={(e) => setTo(e.target.value)} />
        </div>
        <div className="field">
          <label htmlFor="payment-amount">Amount, base units</label>
          <input id="payment-amount" className="input mono" value={amountBaseUnits} onChange={(e) => setAmount(e.target.value)} />
        </div>
        <div className="field">
          <label htmlFor="payment-signature">Transaction signature</label>
          <input id="payment-signature" className="input mono" value={signature} onChange={(e) => setSignature(e.target.value)} />
        </div>
        <div className="field">
          <label htmlFor="payment-finality">Finality</label>
          <select id="payment-finality" className="input" value={finalityStatus} onChange={(e) => setFinality(e.target.value)}>
            <option value="submitted">submitted</option>
            <option value="confirmed">confirmed</option>
            <option value="finalized">finalized</option>
            <option value="reorged">reorged</option>
          </select>
        </div>
        <div className="field">
          <label htmlFor="payment-canonical">Canonicality</label>
          <select id="payment-canonical" className="input" value={canonicalityStatus} onChange={(e) => setCanonical(e.target.value)}>
            <option value="pending">pending</option>
            <option value="canonical">canonical</option>
            <option value="orphaned">orphaned</option>
          </select>
        </div>
        <button
          className="btn btn-primary"
          type="submit"
          disabled={
            busy !== null ||
            instruments.length === 0 ||
            !/^[0-9]+$/.test(amountBaseUnits) ||
            tokenMint.trim() === "" ||
            signature.trim() === ""
          }
        >
          Record observation
        </button>
        <p className="hint">Issuer {shortDigest(issuerId)} — the observation is filed under this issuer&apos;s instruments.</p>
      </form>
    </section>
  );
}

function NoticesSection({
  issuerId,
  notices,
  busy,
  run,
}: {
  issuerId: string;
  notices: NoticeSource[];
  busy: string | null;
  run: Run;
}) {
  const [noticeId, setNoticeId] = useState("");
  const [evidenceUri, setUri] = useState("");
  const [evidenceHash, setHash] = useState("");
  const rows = noticeRows(notices, Date.now());

  return (
    <section className="surface detail-panel" aria-label="Notices">
      <h2 className="section-title section-title--tight">Notices</h2>
      <p className="hint">
        A notice exists to be delivered before a deadline. Delivering one requires evidence — a URI and a hash —
        because “we emailed them” is not proof the agreement accepts.
      </p>
      {rows.length === 0 ? (
        <p className="hint">No notice schedule yet.</p>
      ) : (
        <table className="table">
          <thead>
            <tr>
              <th scope="col">Notice</th>
              <th scope="col">Type</th>
              <th scope="col">Effective</th>
              <th scope="col">Due</th>
              <th scope="col">Delivered</th>
              <th scope="col">Status</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.id}>
                <td className="mono">{shortDigest(row.id)}</td>
                <td>{row.type}</td>
                <td>{row.effective}</td>
                <td>{row.due}</td>
                <td>{row.delivered}</td>
                <td>
                  <span className="chip" data-tone={row.tone}>
                    {row.status}
                  </span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <div className="row">
        <button
          className="btn btn-sm"
          disabled={busy !== null}
          onClick={() => run("schedule notices", () => stampPost("/stamp/admin/notices", { issuerId }))}
        >
          Schedule notices from the contract calendar
        </button>
      </div>
      <form
        className="stack"
        onSubmit={(e) => {
          e.preventDefault();
          void run("deliver notice", () =>
            stampPost(`/stamp/admin/notices/${noticeId}/deliver`, { evidenceUri, evidenceHash }),
          );
        }}
      >
        <div className="field">
          <label htmlFor="notice-id">Notice to mark delivered</label>
          <select id="notice-id" className="input" value={noticeId} onChange={(e) => setNoticeId(e.target.value)}>
            {notices.map((n) => (
              <option key={n.id} value={n.id}>
                {n.noticeType} — {shortDigest(n.id)}
              </option>
            ))}
          </select>
        </div>
        <div className="field">
          <label htmlFor="notice-uri">Delivery evidence URI</label>
          <input id="notice-uri" className="input mono" value={evidenceUri} onChange={(e) => setUri(e.target.value)} />
        </div>
        <div className="field">
          <label htmlFor="notice-hash">Delivery evidence SHA-256</label>
          <input id="notice-hash" className="input mono" value={evidenceHash} onChange={(e) => setHash(e.target.value)} />
        </div>
        <button
          className="btn btn-sm"
          type="submit"
          disabled={busy !== null || !noticeId || !/^[0-9a-f]{64}$/i.test(evidenceHash) || evidenceUri.trim() === ""}
        >
          Record delivery
        </button>
      </form>
    </section>
  );
}

function StructuringSection({
  issuerId,
  event,
  setEvent,
  busy,
  run,
}: {
  issuerId: string;
  event: StructuringEvent | null;
  setEvent: (value: StructuringEvent | null) => void;
  busy: string | null;
  run: Run;
}) {
  const [metaDaoProjectRef, setRef] = useState("");
  const [totalNetworkTokens, setTotal] = useState("");
  const [tokenMint, setMint] = useState("");
  const [tokenProgramId, setProgram] = useState("");
  const [legalSupplySnapshotHash, setHash] = useState("");
  const [metaDaoApprovalRef, setApproval] = useState("");
  const [observedSupply, setObserved] = useState("");
  const [metaDaoConfirmed, setConfirmed] = useState(false);

  return (
    <section className="surface detail-panel" aria-label="Structuring event">
      <h2 className="section-title section-title--tight">Token structuring event</h2>
      <p className="hint">
        Preparing the event records the approved MetaDAO reference and locks the legal supply snapshot.
        Reconciliation compares that snapshot, the investor reserve and the team band with what the chain reports;
        a mismatch holds the event instead of advancing it.
      </p>
      {event && (
        <div className="row">
          <span className="chip" data-tone="gold">
            {event.status}
          </span>
          <span className="hint mono">
            {shortDigest(event.id)} · supply {baseUnits(event.totalNetworkTokens)} · mint {shortDigest(event.tokenMint)} ·
            finality {event.finalityStatus}
          </span>
        </div>
      )}
      <form
        className="stack"
        onSubmit={(e) => {
          e.preventDefault();
          void (async () => {
            const result = await stampPost<{ event: StructuringEvent }>("/stamp/admin/structuring-event/prepare", {
              issuerId,
              metaDaoProjectRef,
              totalNetworkTokens,
              tokenMint,
              tokenProgramId,
              legalSupplySnapshotHash,
              metaDaoApprovalRef,
            });
            if (result.ok) setEvent(result.data.event);
            await run("prepare structuring event", () => Promise.resolve(result));
          })();
        }}
      >
        <h3 className="kicker">Prepare</h3>
        <div className="field">
          <label htmlFor="tse-project">MetaDAO project reference</label>
          <input id="tse-project" className="input mono" value={metaDaoProjectRef} onChange={(e) => setRef(e.target.value)} />
        </div>
        <div className="field">
          <label htmlFor="tse-supply">Total network tokens</label>
          <input id="tse-supply" className="input mono" value={totalNetworkTokens} onChange={(e) => setTotal(e.target.value)} />
        </div>
        <div className="field">
          <label htmlFor="tse-mint">Token mint</label>
          <input id="tse-mint" className="input mono" value={tokenMint} onChange={(e) => setMint(e.target.value)} />
        </div>
        <div className="field">
          <label htmlFor="tse-program">Token program id</label>
          <input id="tse-program" className="input mono" value={tokenProgramId} onChange={(e) => setProgram(e.target.value)} />
        </div>
        <div className="field">
          <label htmlFor="tse-hash">Legal supply snapshot SHA-256</label>
          <input id="tse-hash" className="input mono" value={legalSupplySnapshotHash} onChange={(e) => setHash(e.target.value)} />
        </div>
        <div className="field">
          <label htmlFor="tse-approval">MetaDAO approval reference</label>
          <input id="tse-approval" className="input mono" value={metaDaoApprovalRef} onChange={(e) => setApproval(e.target.value)} />
        </div>
        <button
          className="btn btn-primary"
          type="submit"
          disabled={
            busy !== null ||
            !/^[0-9]+$/.test(totalNetworkTokens) ||
            !/^[0-9a-f]{64}$/i.test(legalSupplySnapshotHash) ||
            tokenMint.trim() === "" ||
            tokenProgramId.trim() === "" ||
            metaDaoApprovalRef.trim() === ""
          }
        >
          Prepare event
        </button>
      </form>
      <form
        className="stack"
        onSubmit={(e) => {
          e.preventDefault();
          if (!event) return;
          void run("reconcile structuring event", () =>
            stampPost(`/stamp/admin/structuring-event/${event.id}/reconcile`, {
              observedSupply: observedSupply || undefined,
              metaDaoConfirmed,
            }),
          );
        }}
      >
        <h3 className="kicker">Reconcile</h3>
        <div className="field">
          <label htmlFor="tse-observed">Supply the chain reports (optional)</label>
          <input id="tse-observed" className="input mono" value={observedSupply} onChange={(e) => setObserved(e.target.value)} />
        </div>
        <label className="row">
          <input type="checkbox" checked={metaDaoConfirmed} onChange={(e) => setConfirmed(e.target.checked)} />
          <span className="hint">MetaDAO has confirmed this event</span>
        </label>
        <button className="btn btn-sm" type="submit" disabled={busy !== null || !event}>
          Reconcile {event ? shortDigest(event.id) : "—"}
        </button>
      </form>
    </section>
  );
}

function LedgerSection({
  issuerId,
  report,
  setReport,
  audit,
  setAudit,
  busy,
  setBusy,
  setError,
  setDenied,
}: {
  issuerId: string;
  report: ReconReport | null;
  setReport: (value: ReconReport | null) => void;
  audit: AuditEvent[];
  setAudit: (value: AuditEvent[]) => void;
  busy: string | null;
  setBusy: (value: string | null) => void;
  setError: (value: string | null) => void;
  setDenied: (value: string | null) => void;
}) {
  const load = async () => {
    setBusy("ledger");
    setError(null);
    const recon = await stampGet<{ report: ReconReport }>(`/stamp/admin/reconciliation?issuer=${issuerId}`);
    if (!recon.ok) {
      if (isDenied(recon.status)) setDenied(recon.message);
      else setError(`reconciliation: ${recon.message}`);
    } else setReport(recon.data.report);
    const log = await stampGet<{ audit: AuditEvent[] }>("/stamp/admin/audit?limit=25");
    if (log.ok) setAudit(log.data.audit);
    else if (!recon.ok && isDenied(log.status)) setDenied(log.message);
    setBusy(null);
  };

  return (
    <section className="surface detail-panel" aria-label="Ledger">
      <h2 className="section-title section-title--tight">Ledger and audit</h2>
      <button className="btn btn-sm" onClick={() => void load()} disabled={busy !== null}>
        Read reconciliation and audit
      </button>
      {report && (
        <div className="metric-grid">
          <p className="surface detail-panel">
            <strong>Reserve</strong>
            <span className="hint hint--block">
              {bps(report.reserve.effectiveBps)} of a {bps(report.reserve.capBps)} cap ·{" "}
              {bps(report.reserve.headroomBps)} headroom
            </span>
          </p>
          <p className="surface detail-panel">
            <strong>Payments</strong>
            <span className="hint hint--block">
              {report.payments.observed} observed · {report.payments.verified} verified · {report.payments.refused} refused
            </span>
          </p>
          <p className="surface detail-panel">
            <strong>Notices</strong>
            <span className="hint hint--block">
              {report.notices.outstanding} outstanding · {report.notices.overdue} overdue
            </span>
          </p>
          <p className="surface detail-panel">
            <strong>Deliveries</strong>
            <span className="hint hint--block">
              {report.deliveryRequests.open} open · {report.deliveryRequests.approved} approved ·{" "}
              {report.deliveryRequests.reconciled} reconciled
            </span>
          </p>
        </div>
      )}
      {report && (
        <table className="table">
          <thead>
            <tr>
              <th scope="col">Instrument status</th>
              <th scope="col">Count</th>
            </tr>
          </thead>
          <tbody>
            {report.instruments.map((row) => (
              <tr key={row.status}>
                <td>{row.status}</td>
                <td className="mono">{row.count}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {audit.length > 0 && (
        <table className="table">
          <thead>
            <tr>
              <th scope="col">When</th>
              <th scope="col">Actor</th>
              <th scope="col">Action</th>
              <th scope="col">Detail</th>
            </tr>
          </thead>
          <tbody>
            {audit.map((event) => (
              <tr key={event.id}>
                <td>{when(event.at)}</td>
                <td className="mono">{shortDigest(event.actor)}</td>
                <td>{event.action}</td>
                <td className="hint">{event.detail || UNKNOWN}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}
