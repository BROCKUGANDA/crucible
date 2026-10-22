"use client";

import type { ReactNode } from "react";
import { Crack, Chrome, SignalLost } from "@/components/Chrome";
import { useOps, useSnapshot, type Probe } from "@/lib/useSnapshot";
import { deriveOps } from "@/lib/ops";
import type { Tone } from "@/lib/forge";

/**
 * The assay — what this site measured about itself, and what it could not.
 *
 * The name is the fire-assay: the test that decides whether a bar of metal is what it has been
 * stamped to be. This page is that test pointed at the site's own claims. Every number on it
 * came from a live endpoint seconds ago, and the endpoint is named beside the number, so the
 * reader can check the attribution instead of taking it on faith.
 *
 * Nothing here is derived, averaged, projected or filled in. A value the API did not publish
 * prints as an em dash — the glyph this site already uses for "no measurement", shared with
 * `formatEth` and `formatDuration` — because a zero that means "we never fetched it" is a
 * measurement nobody made. `src/lib/ops.ts` owns that mapping and `test/ops.test.ts` asserts it.
 *
 * The page is read-only, and not by omission. The API holds no chain key (ADR-0006), so nothing
 * reachable from here can move a stake, settle a trial, or submit anything.
 */
export default function AssayPage() {
  const snap = useSnapshot();
  // The operator endpoints ride the snapshot's clock rather than their own timer: one realtime
  // mechanism decides when this site has fresh information, and a second loop would only spend
  // the API's per-reader budget faster.
  const ops = useOps(snap.serverNowMs);

  const view = deriveOps({
    health: ops.health.data,
    ready: ops.ready.data,
    snapshot: snap.data,
    serverNowMs: snap.serverNowMs,
  });

  const health = asRead(ops.health);
  const ready = asRead(ops.ready);
  const snapshot: Read = {
    loading: snap.loading,
    error: snap.error,
    read: snap.data !== null,
    // A frame delivered by the live stream has no status code to quote. Inventing one would be
    // the page claiming a measurement it does not have.
    status: null,
  };

  // Nothing at all came back: no snapshot, neither operator endpoint, and both finished trying.
  // That is an unreachable API, which is what `Crack` and `Try again` are for elsewhere on this
  // site (`src/app/error.tsx`) — so it is what they are for here too, rather than a grid of
  // em dashes pretending to be a report.
  const nothingRead =
    !health.read &&
    !ready.read &&
    !snapshot.read &&
    !health.loading &&
    !ready.loading &&
    !snapshot.loading;

  if (nothingRead) {
    return (
      <Chrome>
        <h1 className="page-title">Assay</h1>
        <p className="lede assay-lede">
          The site&apos;s own operator readings, published by the API and rendered as it received
          them. An em dash means the number was not measured — never that it was zero.
        </p>
        {/* The same shape `src/app/error.tsx` uses for a page that cannot render: the crack plate
            with its own retry under it. `Try again` re-reads the two operator endpoints this page
            owns — the live snapshot reconnects on its own, and a button that reloaded the document
            to prove a socket was dead would blur two different failures into one. */}
        <div className="error-page">
          <Crack
            message={
              health.error ??
              ready.error ??
              snapshot.error ??
              "the API answered neither /health, /ready, nor /snapshot"
            }
          />
          <div className="error-page__retry">
            <button className="btn btn-ghost" type="button" onClick={ops.retry}>
              Try again
            </button>
          </div>
        </div>
      </Chrome>
    );
  }

  const anyFailed = health.error !== null || ready.error !== null || snapshot.error !== null;

  return (
    <Chrome>
      <h1 className="page-title">Assay</h1>
      <p className="lede assay-lede">
        The site&apos;s own operator readings, published by the API and rendered as it received
        them. An em dash means the number was not measured — never that it was zero.
      </p>

      {/* The skeleton bars are `aria-hidden`, so the reading state has to be said somewhere a
          screen reader will hear it change. This line is that place: it names each endpoint and
          whether it answered, which is also the first thing a sighted reader needs to know. */}
      <p className="mono assay-sources" role="status" aria-live="polite" aria-label="Source readings">
        <span className="assay-sources__item">{sourceNote("/health", health)}</span>
        <span className="assay-sources__item">{sourceNote("/ready", ready)}</span>
        <span className="assay-sources__item">{sourceNote("/snapshot", snapshot)}</span>
      </p>

      {snapshot.error ? <SignalLost message={snapshot.error} /> : null}
      {anyFailed ? (
        <p className="row assay-actions">
          <span className="hint">
            A source that did not answer prints em dashes rather than a number nobody read.
          </span>
          <button className="btn btn-ghost btn-sm" type="button" onClick={ops.retry}>
            Try again
          </button>
        </p>
      ) : null}

      <section className="surface detail-panel assay-verdict" aria-label="Current reading">
        <h2 className="section-title section-title--tight">Where the reading stands</h2>
        <p className="mono assay-verdict__reach" data-tone={view.reachTone}>
          {view.reach}
        </p>
        <p className="row">
          <span className="chip" data-tone={view.readyTone}>
            readiness: {view.readyVerdict}
          </span>
          <span className="chip" data-tone={view.apiVerdictTone}>
            its own verdict: {view.apiVerdict}
          </span>
        </p>
        <p className="mono assay-verdict__reason" data-tone="dim">
          {view.readyReason}
        </p>
        <p className="hint">
          Both verdicts are the forge&apos;s own conclusions about itself, quoted here rather than
          recomputed by this page.
        </p>
      </section>

      <div className="assay-grid">
        <Panel title="How far it has read" source="/health · /ready">
          <Row label="Read up to block" value={view.indexedTo} loading={health.loading} />
          <Row label="Head of the chain" value={view.head} loading={health.loading} />
          <Row label="Blocks behind" value={view.lag} loading={health.loading || ready.loading} />
          <Row label="Served within" value={view.tolerance} loading={ready.loading} />
          <p className="hint">The blocks-behind figure is the one {view.lagSource}.</p>
        </Panel>

        <Panel title="What it could not read" source="/health · /ready">
          <Row
            label="Last failed read"
            value={view.syncError}
            loading={health.loading && ready.loading}
            tone={view.syncErrorTone}
          />
          <p className="hint">
            What the reader itself said about a stretch of chain it could not go through. It is
            published because it names the failure, not a secret.
          </p>
        </Panel>

        <Panel title="Failures it kept" source="/health · dlq">
          <Row label="Kept" value={view.dlqSize} loading={health.loading} />
          <Row label="Last one was" value={view.dlqLastKind} loading={health.loading} />
          <Row label="Happened" value={view.dlqLastAge} loading={health.loading} />
          <p className="hint">
            It holds the newest hundred, so a count that only climbs is the alarm. The last
            failure&apos;s own words are held back here on purpose: an error out of a node can
            carry the node&apos;s address, and an address can carry a key.
          </p>
        </Panel>

        <Panel title="Trip-wires" source="/health · breakers" bodyClass="assay-breakers">
          {health.loading && view.breakers.length === 0 ? (
            <>
              <SkelRow />
              <SkelRow />
            </>
          ) : view.breakers.length === 0 ? (
            <p className="mono assay-note" data-tone={view.breakersNoteTone}>
              {view.breakersNote}
            </p>
          ) : (
            view.breakers.map((b) => (
              <div key={b.name} className="kv assay-breaker">
                <span className="kv__key">{b.name}</span>
                <span className="row assay-breaker__state">
                  <span className="chip" data-tone={b.tone}>
                    {b.state}
                  </span>
                  <span className="mono" data-tone="faint">
                    {b.failures} · {b.probe}
                  </span>
                </span>
              </div>
            ))
          )}
          {view.breakers.length > 0 ? <p className="hint">{view.breakersNote}</p> : null}
        </Panel>

        <Panel title="Trials, by where they stand" source="/snapshot · counts">
          <Row label="All trials" value={view.total} loading={snapshot.loading} />
          {view.counts.map((c) => (
            <Row key={c.key} label={c.label} value={c.value} loading={snapshot.loading} tone={c.tone} />
          ))}
          <p className="hint">
            The same numbers the trial list reads, so a count here cannot disagree with the page
            beside it.
          </p>
        </Panel>

        <Panel title="The books" source="/snapshot · economics">
          <Row label="Escrowed by sponsors" value={view.volume} loading={snapshot.loading} />
          <Row label="Fees kept" value={view.fees} loading={snapshot.loading} />
          <Row label="Paid to agents" value={view.paidOut} loading={snapshot.loading} />
          <Row label="Settled in an agent's favour" value={view.paidSettlements} loading={snapshot.loading} />
          <Row label="The fee the chain charges" value={view.feeRate} loading={snapshot.loading} />
          <p className="hint">
            ETH only. Nothing here reads a price of ETH in any other money, so a dollar figure on
            this page would be invented rather than measured. The fee is read off the chain: it
            prints an em dash when that read failed, because zero would say the forge takes
            nothing, on the authority of a page that does not know.
          </p>
        </Panel>
      </div>

      <p className="hint assay-foot">
        After a restart the forge reads the chain again from the beginning, so an index that has
        only just started looks behind rather than empty. This page reports that distance instead of
        smoothing it over, and it contributes no number of its own.
      </p>
    </Chrome>
  );
}

/** What the page can honestly say about one endpoint at this instant. */
interface Read {
  loading: boolean;
  error: string | null;
  read: boolean;
  /** the HTTP status the endpoint answered with, or null when it never answered */
  status: number | null;
}

function asRead<T>(p: Probe<T>): Read {
  return { loading: p.loading, error: p.error, read: p.data !== null, status: p.status };
}

/**
 * The source line, including the status code the endpoint used.
 *
 * The code is published rather than hidden because `/health` and `/ready` answer 503 while still
 * holding the truth — the red status is the API's own verdict, and a page that flattened it to
 * "ok" would be editing the report. `/snapshot` has no code to quote when the live stream is what
 * delivered it, so that one says what it knows and no more.
 */
function sourceNote(endpoint: string, r: Read): string {
  const outcome = r.loading ? "reading" : r.read ? "read" : "failed";
  const status = r.status === null ? "" : ` ${r.status}`;
  return `${endpoint}${status} ${outcome}`;
}

/**
 * One panel. `source` names the endpoint every number inside it came from, so a reader never has
 * to work out which of six panels is a guess.
 */
function Panel({
  title,
  source,
  bodyClass,
  children,
}: {
  title: string;
  source: string;
  bodyClass?: string;
  children: ReactNode;
}) {
  return (
    <section className="surface detail-panel assay-panel" aria-label={title}>
      <h2 className="section-title section-title--tight">{title}</h2>
      <span className="kicker assay-panel__source">{source}</span>
      <div className={bodyClass}>{children}</div>
    </section>
  );
}

/**
 * A label and its value, at the height the value will occupy when it arrives.
 *
 * While the read is in flight the value slot holds a cold-metal skeleton rather than an em dash:
 * the row is already laid out to its final size, so the number landing shifts nothing on the
 * page. That is the whole reason the `.skeleton` class exists, and the reason it is used here
 * rather than left as a stylesheet nobody wrote against.
 */
function Row({
  label,
  value,
  loading,
  tone,
}: {
  label: string;
  value: string;
  loading: boolean;
  tone?: Tone;
}) {
  return (
    <div className="kv">
      <span className="kv__key">{label}</span>
      {loading ? (
        <SkelValue />
      ) : (
        <span className="mono figures" data-tone={tone}>
          {value}
        </span>
      )}
    </div>
  );
}

function SkelValue() {
  return <span className="skeleton assay-skel" aria-hidden="true" />;
}

function SkelRow() {
  return (
    <div className="kv">
      <span className="skeleton assay-skel assay-skel--key" aria-hidden="true" />
      <span className="skeleton assay-skel" aria-hidden="true" />
    </div>
  );
}
