"use client";

import { useMemo } from "react";
import Link from "next/link";
import { useReadContracts } from "wagmi";
import { TRIALS_ABI } from "@crucible/smith";
import { Chrome, Quenching } from "@/components/Chrome";
import { deployment } from "@/lib/wagmi";
import {
  CLOCK_FUNCTIONS,
  clockRead,
  deriveBooks,
  deriveClock,
  unreadNote,
  type ClockReads,
  type ClockRow,
} from "@/lib/clock";

/**
 * The clock and the books — how a decision gets made, told entirely in the chain's own numbers.
 *
 * The docs page *describes* the windows ("1 hour to 7 days", "two of three", "5% fee"); this page
 * *shows* them, and reads them from the contract at view time rather than copying them into the
 * bundle. That distinction is the whole reason the page exists: a number retyped into a front end
 * is a number that goes quietly wrong the day the contract changes, and a judge who is being told
 * "the fee is fixed in the contract" is entitled to see the contract's figure, not the site's
 * memory of it.
 *
 * When there is no deployment wired into this build, every figure prints the em dash and the page
 * says so out loud. It does not fall back to a table of plausible constants, because a page about
 * what the protocol charges that invents a fee is exactly the fabricated measurement this site has
 * spent its whole existence refusing.
 */
export default function ClockPage() {
  const dep = deployment();

  // One batched read of every constant, so the page does not open fourteen round-trips. Gated on
  // a real deployment: pointed at the zero address it would read the void and paint void numbers.
  const contracts = useMemo(
    () =>
      CLOCK_FUNCTIONS.map((functionName) => ({
        address: dep.trials,
        abi: TRIALS_ABI,
        functionName,
      })),
    [dep.trials],
  );

  const { data, isLoading } = useReadContracts({
    contracts,
    allowFailure: true,
    query: { enabled: dep.configured },
  });

  const reads: ClockReads = {};
  if (Array.isArray(data)) {
    CLOCK_FUNCTIONS.forEach((name, i) => {
      const slot = (data as { status?: string; result?: unknown }[])[i];
      if (slot?.status === "success" && typeof slot.result === "bigint") reads[name] = slot.result;
    });
  }

  const read = clockRead(reads);
  const { phases, committee } = deriveClock(reads);
  const books = deriveBooks(reads);

  return (
    <Chrome>
      <p className="kicker">The rules, as the chain holds them</p>
      <h1 className="page-title">How a decision gets made</h1>
      <p className="lede clock-lede">
        A trial runs on a clock, and it settles on a bill. Both are fixed in the contract, not
        written on this site — so the figures below are read from the chain the moment you open the
        page. If a number here ever disagrees with the contract, the contract is right and this
        page is stale; that is what reading it live is for.
      </p>

      {!dep.configured ? (
        <p className="surface clock-unread" role="status">
          {unreadNote()}
        </p>
      ) : null}
      {dep.configured && isLoading && !read ? <Quenching label="reading the clock…" /> : null}

      <section className="surface detail-panel clock-panel" id="settlement-clock" aria-label="The clock">
        <h2 className="section-title section-title--tight">The clock</h2>
        <p className="clock-prose">
          A sponsor sets a submission window and a skeptic window when the trial is lit. Once a run
          is handed in, the skeptic window is the only time a challenge can be filed. If one is,
          each of the three seats has the commit window to seal its verdict, and the case can sit
          open until the auto-settle line — after which a committee that has not decided pays the
          agent, because the burden of proof was on the one who challenged.
        </p>
        <ol className="clock-list">
          {phases.map((r) => (
            <ClockLine key={r.label} row={r} />
          ))}
        </ol>
      </section>

      <section className="surface detail-panel clock-panel" aria-label="The committee">
        <h2 className="section-title section-title--tight">The committee</h2>
        <p className="clock-prose">
          A break is judged by three seats — the watchful ones, Argus — and it takes two to move
          the metal. Each seat commits its verdict before any are revealed, so no seat can copy
          another; the threshold below is what settles the trial.
        </p>
        <ul className="clock-list">
          {committee.map((r) => (
            <ClockLine key={r.label} row={r} />
          ))}
        </ul>
      </section>

      <section className="surface detail-panel clock-panel" aria-label="The books">
        <h2 className="section-title section-title--tight">The books</h2>
        <p className="clock-prose">
          Money is locked before work begins. The reward sits in the contract from the moment the
          trial is lit; the agent stakes a bond to claim it; a skeptic stakes against the claim to
          challenge it. The forge only ever takes its cut when work is actually paid out — and the
          rate is the contract&apos;s, shown here, not a rounded figure the marketing page settled
          on.
        </p>
        <ul className="clock-list">
          {books.map((r) => (
            <ClockLine key={r.label} row={r} />
          ))}
        </ul>
        <p className="hint">
          ETH only. Nothing here reads a price of ETH in any other money, so a dollar figure would
          be invented rather than measured — and the metal this demo runs on is test ETH, worth
          nothing.
        </p>
      </section>

      <p className="docs-back">
        <Link href="/docs" data-tone="ember">
          The words, in plain language
        </Link>{" "}
        <span data-tone="dim">·</span>{" "}
        <Link href="/trials" data-tone="ember">
          See the trials
        </Link>
      </p>
    </Chrome>
  );
}

/**
 * One labelled figure. `read` decides the colour and whether the value is a measurement or the
 * em dash — an unread row is dimmed and says which getters it is waiting on, so the page never
 * looks like it measured something it did not.
 */
function ClockLine({ row }: { row: ClockRow }) {
  return (
    <li className="clock-line" data-read={row.read || undefined}>
      <span className="clock-line__label">{row.label}</span>
      <span className="mono clock-line__value" data-tone={row.read ? "gold" : "faint"}>
        {row.value}
      </span>
      <span className="mono clock-line__source">{row.source}</span>
    </li>
  );
}
