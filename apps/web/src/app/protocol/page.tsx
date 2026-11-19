"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { Chrome, Quenching } from "@/components/Chrome";
import { API_BASE } from "@/lib/apiBase";
import {
  ALLOCATION_BANDS,
  BOUNDARIES,
  DELIVERY_CHECKS,
  LOCKUP_TEXT,
  RESERVE_CAP_TEXT,
  formatBps,
  formatCount,
  modeView,
  publicFacts,
  type ModeView,
  type OwnershipResponse,
  type TransparencyResponse,
} from "@/lib/protocol/view";

type Load<T> = { state: "loading" } | { state: "ready"; value: T } | { state: "absent"; note: string };

/**
 * The public projection, and a door into each private surface.
 *
 * Three audiences share one identity system and one policy layer, and they get
 * different answers here — a developer sees the product, an investor sees their
 * own record, a token holder sees the public governance facts. The page does not
 * add an "investor" item to everybody's navigation: it is one route a visitor
 * has to mean to open.
 */
export default function ProtocolPage() {
  const [ownership, setOwnership] = useState<Load<OwnershipResponse>>({ state: "loading" });
  const [issuerId, setIssuerId] = useState<string>("");
  const [transparency, setTransparency] = useState<Load<TransparencyResponse>>({ state: "loading" });

  useEffect(() => {
    fetch(`${API_BASE}/stamp/protocol/ownership`)
      .then(async (res) => {
        const body = (await res.json().catch(() => ({}))) as OwnershipResponse;
        if (res.status === 404) {
          setOwnership({ state: "absent", note: "The protocol-ownership surface is not offered on this host." });
          return;
        }
        if (!res.ok) {
          setOwnership({ state: "absent", note: `The ownership read answered HTTP ${res.status}.` });
          return;
        }
        setOwnership({ state: "ready", value: body });
      })
      .catch(() => setOwnership({ state: "absent", note: "This host did not answer the ownership read." }));
  }, []);

  useEffect(() => {
    if (!issuerId) return;
    setTransparency({ state: "loading" });
    fetch(`${API_BASE}/stamp/protocol/transparency?issuer=${encodeURIComponent(issuerId)}`)
      .then(async (res) => {
        const body = (await res.json().catch(() => ({}))) as TransparencyResponse;
        if (!res.ok) {
          setTransparency({ state: "absent", note: `The transparency read answered HTTP ${res.status}.` });
          return;
        }
        setTransparency({ state: "ready", value: body });
      })
      .catch(() => setTransparency({ state: "absent", note: "This host did not answer the transparency read." }));
  }, [issuerId]);

  const mode: ModeView | null = ownership.state === "ready" ? modeView(ownership.value) : null;
  const facts =
    transparency.state === "ready" ? publicFacts(transparency.value) : publicFacts(null);

  return (
    <Chrome>
      <p className="kicker">Protocol · Ownership</p>
      <h1 className="page-title" id="protocol-ownership">
        The agreement behind the token
      </h1>

      <div className="surface detail-panel">
        {ownership.state === "loading" ? <Quenching label="reading the protocol surface" /> : null}
        {ownership.state === "absent" ? (
          <p className="hint hint--block" data-tone="sear">
            {ownership.note} Nothing is shown rather than shown empty: an absent surface is not a zero.
          </p>
        ) : null}
        {mode ? (
          <>
            <p className="hint hint--block" data-tone={mode.productionUnlocked ? "verdant" : undefined}>
              <strong>{mode.notice}</strong>
            </p>
            {mode.note ? <p className="hint hint--block">{mode.note}</p> : null}
            <p className="hint">
              Mode: <span className="mono">{mode.mode}</span>
              {mode.mode === "production" ? (
                mode.productionUnlocked ? (
                  <> · preflight manifest matched</>
                ) : (
                  <> · preflight manifest not matched</>
                )
              ) : null}
            </p>
          </>
        ) : null}
      </div>

      <div className="surface detail-panel">
        <h2 className="section-title" id="protocol-public">
          What is public
        </h2>
        <p className="hint hint--block">
          Aggregate facts only. No holder name, purchase price or portion is published here, and no private document
          is served from this page.
        </p>
        <label className="hint" htmlFor="protocol-issuer">
          Issuer id (published by the issuer console)
        </label>
        <input
          id="protocol-issuer"
          className="input"
          value={issuerId}
          onChange={(event) => setIssuerId(event.target.value)}
          placeholder="issuer-…"
          autoComplete="off"
        />
        {transparency.state === "loading" && issuerId ? <Quenching label="reading published facts" /> : null}
        {transparency.state === "absent" ? (
          <p className="hint hint--block" data-tone="sear">
            {transparency.note}
          </p>
        ) : null}
        <dl className="hint">
          <dt>Legal entity</dt>
          <dd className="mono">{facts.legalEntityName}</dd>
          <dt>Jurisdiction</dt>
          <dd className="mono">{facts.jurisdictionCode}</dd>
          <dt>Issuer readiness</dt>
          <dd className="mono">{facts.status}</dd>
          <dt>Total network tokens</dt>
          <dd className="mono">{facts.totalNetworkTokens}</dd>
          <dt>Investor reserve</dt>
          <dd className="mono">{facts.investorReserve}</dd>
          <dt>Founder and service providers</dt>
          <dd className="mono">{facts.teamAllocation}</dd>
          <dt>Token mint</dt>
          <dd className="mono">{facts.tokenMint}</dd>
          <dt>DAO treasury</dt>
          <dd className="mono">{facts.daoTreasury}</dd>
          <dt>Holders on record</dt>
          <dd className="mono">{facts.holders}</dd>
          <dt>Allocations calculated</dt>
          <dd className="mono">{facts.allocated}</dd>
        </dl>
        <p className="hint hint--block">
          An em dash means this host has not read that figure. It never means zero.
        </p>
      </div>

      <div className="surface detail-panel">
        <h2 className="section-title" id="protocol-bands">
          The bands a launch has to sit inside
        </h2>
        <ul className="hint hint--block">
          {ALLOCATION_BANDS.map((band) => (
            <li key={band}>{band}</li>
          ))}
        </ul>
        <p className="hint hint--block">{RESERVE_CAP_TEXT}</p>
        <p className="hint hint--block">{LOCKUP_TEXT}</p>
      </div>

      <div className="surface detail-panel">
        <h2 className="section-title" id="protocol-delivery">
          What has to be true before anything is called delivered
        </h2>
        <ol className="hint hint--block">
          {DELIVERY_CHECKS.map((check) => (
            <li key={check}>{check}</li>
          ))}
        </ol>
        <p className="hint hint--block">
          A submitted transaction is not a delivery. A screenshot is not a payment. A status column is not a balance.
        </p>
      </div>

      <div className="surface detail-panel">
        <h2 className="section-title" id="protocol-boundaries">
          Where this stops
        </h2>
        <ul className="hint hint--block">
          {BOUNDARIES.map((line) => (
            <li key={line}>{line}</li>
          ))}
        </ul>
        <p className="hint hint--block">
          MetaDAO&apos;s own pages are the authority for the sale, the treasury and the decision markets. This page links
          to them rather than restating them: <a href="https://metadao.com/docs/stamp">metadao.com/docs/stamp</a>.
        </p>
      </div>

      <div className="surface detail-panel">
        <h2 className="section-title" id="protocol-doors">
          The three doors
        </h2>
        <p className="hint hint--block">
          Each door needs its own authority. A connected wallet is not an identity, and signing in as a reviewer is not
          signing in as an investor.
        </p>
        <ul className="hint hint--block">
          <li>
            <strong>Issuer console.</strong> A configured reviewer records counsel approval, payments, notices and
            delivery decisions. Every route refuses an unconfigured reviewer list.{" "}
            <Link href="/protocol/issuer">Open the issuer console</Link> with a reviewer session.
          </li>
          <li>
            <strong>Investor portal.</strong> A holder sees only their own instrument, and only after a reviewer has
            bound their verified address to the holder record. The API answers <span className="mono">403</span> for a
            signed-in wallet with no binding, rather than an empty list.{" "}
            <Link href="/protocol/investor">Open the investor portal</Link>.
          </li>
          <li>
            <strong>Public transparency.</strong> The figures above, and the governance links below.
          </li>
        </ul>
        <p className="hint">
          Related: <Link href="/solana">the Solana console</Link> · <Link href="/escrow">trial escrow</Link> — a
          different ledger, deliberately.
        </p>
      </div>

      <div className="surface detail-panel">
        <h2 className="section-title" id="protocol-vesting">
          The 24 monthly releases
        </h2>
        <p className="hint hint--block">
          Delivered tokens unlock one month at a time. The monthly amounts are whole base units and they sum to exactly
          what was delivered: any remainder lands in the final release rather than being rounded away.
        </p>
        <p className="hint">
          Example, 1,000,000 base units over 24 months:{" "}
          <span className="mono">{exampleVector()}</span>
        </p>
        <p className="hint hint--block">
          The each-month figure below is the smallest and largest release in that example, so the shape is visible
          without pretending a single number describes the whole schedule.
        </p>
        <p className="hint">
          Smallest <span className="mono">{formatCount(exampleRange().min)}</span> · largest{" "}
          <span className="mono">{formatCount(exampleRange().max)}</span> · releases{" "}
          <span className="mono">{formatCount(24)}</span>
        </p>
      </div>

      <div className="surface detail-panel">
        <h2 className="section-title" id="protocol-numbers">
          Numbers, in the units they are held in
        </h2>
        <p className="hint hint--block">
          Percentages are basis points and token amounts are base units. Nothing crosses a float on the way here.
        </p>
        <ul className="hint hint--block">
          <li>
            A 5% allocation reads <span className="mono">{formatBps("500")}</span>
          </li>
          <li>
            The investor cap reads <span className="mono">{formatBps("2000")}</span>
          </li>
          <li>
            An unread figure reads <span className="mono">{formatBps(null)}</span>
          </li>
        </ul>
      </div>
    </Chrome>
  );
}

/** The 24-month vector for 1,000,000 base units, computed the way the domain does. */
function releaseVector(total: bigint = 1_000_000n, months = 24): bigint[] {
  const per = total / BigInt(months);
  const remainder = total % BigInt(months);
  const out: bigint[] = [];
  for (let i = 0; i < months; i++) out.push(per + (BigInt(i) < remainder ? 1n : 0n));
  return out;
}

function exampleVector(): string {
  const vector = releaseVector();
  return `${vector[0]!.toString()} … ${vector[vector.length - 1]!.toString()} (24 values, summing to ${vector
    .reduce((a, b) => a + b, 0n)
    .toString()})`;
}

function exampleRange(): { min: number; max: number } {
  const vector = releaseVector();
  const numbers = vector.map((v) => Number(v));
  return { min: Math.min(...numbers), max: Math.max(...numbers) };
}