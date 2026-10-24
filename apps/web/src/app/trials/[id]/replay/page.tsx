"use client";

import Link from "next/link";
import { useParams } from "next/navigation";
import { useEffect, useMemo, useRef, useState } from "react";
import { Chrome, ColdForge, Quenching, SignalLost } from "@/components/Chrome";
import { StageRail } from "@/components/replay/StageRail";
import { Timeline } from "@/components/replay/Timeline";
import { MoneyFlow } from "@/components/replay/MoneyFlow";
import { flowRows, railRows } from "@/lib/replay/view";
import { API_BASE } from "@/lib/apiBase";
import {
  DEFAULT_BUDGET,
  FrenchySelector,
  readFrenchyPrefs,
  type QuipRecord,
} from "@/lib/frenchy/selector";
import type { Replay } from "@crucible/frame";

/**
 * The replay.
 *
 * One read per trial id, and every state that read can answer with gets its own visible shape: a
 * record that does not exist, a deployment that does not keep one, a chain that did not answer, a
 * window that starts after the trial was posted, and a trial with nothing in it. A reader who
 * cannot tell "no history" from "no history available" is being told something false by the page.
 *
 * The rules do not live here. The rail rows, the money rows and the speakable marks all come from
 * `lib/replay/view.ts`; the caption comes out of `FrenchySelector`, whose pools are static. This
 * file fetches, holds the cursor, and says what it is waiting for.
 */

interface ReplayMeta {
  trialId: number;
  logsFound: number;
  logsUndecoded: number;
  range: { fromBlock: number; toBlock: number };
  beforeWindow: boolean;
}

type Phase =
  | { kind: "reading" }
  | { kind: "unreachable" }
  | { kind: "refused"; status: number }
  | { kind: "unreadable" }
  | { kind: "ready"; replay: Replay; meta: ReplayMeta };

export default function TrialReplayPage() {
  const params = useParams<{ id: string }>();
  const id = params?.id ?? "";
  const [phase, setPhase] = useState<Phase>({ kind: "reading" });
  const [cursor, setCursor] = useState(0);

  useEffect(() => {
    let alive = true;
    const controller = new AbortController();
    setPhase({ kind: "reading" });
    setCursor(0);

    void (async () => {
      let res: Response;
      try {
        res = await fetch(`${API_BASE}/replay/${id}`, { signal: controller.signal });
      } catch {
        // The request itself dying is a different fact from the server answering it badly, and
        // the page says them differently.
        if (alive) setPhase({ kind: "unreachable" });
        return;
      }
      if (!res.ok) {
        if (alive) setPhase({ kind: "refused", status: res.status });
        return;
      }
      let body: unknown;
      try {
        body = await res.json();
      } catch {
        if (alive) setPhase({ kind: "unreadable" });
        return;
      }
      const parsed = asReplay(body);
      if (alive) {
        if (parsed === null) setPhase({ kind: "unreadable" });
        else setPhase({ kind: "ready", ...parsed });
      }
    })();

    return () => {
      alive = false;
      controller.abort();
    };
  }, [id]);

  const replay = phase.kind === "ready" ? phase.replay : null;
  const meta = phase.kind === "ready" ? phase.meta : null;

  const rows = useMemo(() => (replay ? railRows(replay) : []), [replay]);
  const flows = useMemo(() => (replay ? flowRows(replay) : []), [replay]);

  // ── Frenchy ────────────────────────────────────────────────────────────────
  // One selector per page view, seeded from the trial id, so the same replay shows the same line
  // to the same reader (gate 675) rather than a fresh roll on every render.
  const selectorRef = useRef<FrenchySelector | null>(null);
  // Frame numbers already answered for. A beat is asked once, even if the cursor comes back to it.
  const attempted = useRef<Set<number>>(new Set());
  const [quip, setQuip] = useState<{ record: QuipRecord; frame: number } | null>(null);

  // A new replay is a new page view: the seed, the history and the cooldown all start over.
  useEffect(() => {
    selectorRef.current = null;
    attempted.current = new Set();
    setQuip(null);
  }, [replay]);

  useEffect(() => {
    const row = rows[cursor];
    // Arriving on the first beat counts as moving onto it; the alternative is a replay that opens
    // on its most speakable beat and says nothing.
    if (!row || row.trigger === null || !row.speakable) return;
    if (attempted.current.has(row.n)) return;
    attempted.current.add(row.n);

    if (selectorRef.current === null) {
      const prefs = readFrenchyPrefs(typeof localStorage !== "undefined" ? localStorage : null);
      selectorRef.current = new FrenchySelector(
        `replay-${id}`,
        () => Date.now(),
        DEFAULT_BUDGET,
        [],
        prefs.muted,
        prefs.dismissals,
      );
    }
    // `false`, not a guess: this page has no wallet action and no verification form in flight, so
    // there is no silence zone to respect here (gate 671).
    const result = selectorRef.current.select(row.trigger, false);
    setQuip(result.quip ? { record: result.quip, frame: row.n } : null);
  }, [cursor, rows, id]);

  // ── the states ─────────────────────────────────────────────────────────────
  if (phase.kind === "reading") {
    return (
      <Chrome>
        <Header id={id} />
        <Quenching label="reading this trial's beats off the chain…" />
        {/* Cold metal in the shape of the answer. The bars wear the skeleton sizes the design
            system already has (`assay-skel`, one line tall, so nothing jumps when the real row
            lands); `Quenching` above them stays visible because these widths are the rail's line
            height, not the rail's sentences — and a skeleton that lies about the layout is worse
            than no skeleton at all. */}
        <div className="stack" aria-hidden="true">
          {[0, 1, 2, 3, 4].map((i) => (
            <div key={i} className="row">
              <span className="skeleton assay-skel assay-skel--key" />
              <span className="skeleton assay-skel" />
              <span className="skeleton assay-skel" />
            </div>
          ))}
        </div>
      </Chrome>
    );
  }

  if (phase.kind === "unreachable") {
    return (
      <Chrome>
        <Header id={id} />
        <SignalLost message="Nothing answered at the reader. The chain still holds this trial — try again in a moment." />
        <BackLink id={id} />
      </Chrome>
    );
  }

  if (phase.kind === "refused") {
    return (
      <Chrome>
        <Header id={id} />
        {phase.status === 400 ? (
          <div className="surface void-panel">
            <h2 className="void-panel__title" data-tone="sear">
              Not a trial number.
            </h2>
            <p className="void-panel__body">
              A replay asks for one trial, and this address did not carry a number the reader can
              use.
            </p>
          </div>
        ) : null}
        {phase.status === 404 ? (
          <div className="surface void-panel">
            <h2 className="void-panel__title" data-tone="sear">
              Nothing at that number.
            </h2>
            <p className="void-panel__body">
              No trial with that id was ever posted here — or the history it would have been read
              from is long gone.
            </p>
          </div>
        ) : null}
        {phase.status === 501 ? (
          <ColdForge
            line="This deployment does not read a trial's history back off the chain, so there is nothing to replay. The trial itself is real."
            cta="Back to the trial"
            href={`/trials/${id}`}
          />
        ) : null}
        {phase.status === 502 ? (
          <SignalLost message="The chain did not answer the reader. Nothing you did broke this — try again." />
        ) : null}
        {phase.status === 429 ? (
          <SignalLost message="The forge is busy — too many readers at once. Try again shortly." />
        ) : null}
        {![400, 404, 501, 502, 429].includes(phase.status) ? (
          <SignalLost
            message={`The reader answered with ${phase.status}, which this page does not know how to show.`}
          />
        ) : null}
        <BackLink id={id} />
      </Chrome>
    );
  }

  if (phase.kind === "unreadable") {
    return (
      <Chrome>
        <Header id={id} />
        <SignalLost message="The reader answered, but with a body this page could not read." />
        <BackLink id={id} />
      </Chrome>
    );
  }

  const empty = rows.length === 0;

  return (
    <Chrome>
      <Header id={id} />
      <p className="lede">
        Every beat this trial left on the chain, in the order the chain wrote it, read back rather
        than retold. An em dash means the record does not carry that thing — not that it was zero.
      </p>

      {meta?.beforeWindow ? (
        <p className="hint hint--block" data-tone="gold">
          This trial was posted before the oldest block the reader searched — block {meta.range.fromBlock} —
          so its first beats are outside what was looked at, not missing from the chain. Widening
          that window is the only way to see them.
        </p>
      ) : replay?.incomplete ? (
        <p className="hint hint--block" data-tone="gold">
          The history this reader found starts after the trial was posted, so the posting itself is
          not in this replay. What follows is in chain order and unchanged.
        </p>
      ) : null}

      {empty ? (
        <div className="surface void-panel">
          <h2 className="void-panel__title" data-tone="ash">
            No beats on the record.
          </h2>
          <p className="void-panel__body">
            {meta
              ? `The reader searched blocks ${meta.range.fromBlock} to ${meta.range.toBlock} and found nothing this trial left behind.`
              : "The reader found nothing this trial left behind."}
          </p>
        </div>
      ) : (
        <>
          <Timeline rows={rows} cursor={cursor} onCursor={setCursor} />

          <StageRail rows={rows} cursor={cursor} onCursor={setCursor} />

          {/* A refusal renders nothing. "Frenchy is over budget" is a fact about the garnish's
              meter, and a visitor has no use for it — silence is the answer they get. */}
          {quip && quip.frame === rows[cursor]?.n ? (
            <p className="surface detail-panel" data-tone={quip.record.tone}>
              <span className="kicker">Frenchy (AI)</span> <span>{quip.record.text}</span>
            </p>
          ) : null}

          <MoneyFlow rows={flows} />
        </>
      )}

      {meta ? (
        <p className="hint hint--block">
          {meta.logsFound} records read between blocks {meta.range.fromBlock} and{" "}
          {meta.range.toBlock}
          {meta.logsUndecoded > 0
            ? `, and ${meta.logsUndecoded} the reader could not name (left out, not guessed at).`
            : "."}
        </p>
      ) : null}

      <BackLink id={id} />
    </Chrome>
  );
}

/** The page's own head, kept identical in every state so a failure still says where you are. */
function Header({ id }: { id: string }) {
  return (
    <>
      <p className="kicker">Trial {id}</p>
      <h1 className="page-title">The replay</h1>
    </>
  );
}

function BackLink({ id }: { id: string }) {
  return (
    <p className="row">
      <Link className="btn btn-ghost btn-sm" href={`/trials/${id}`}>
        Back to the trial
      </Link>
    </p>
  );
}

/**
 * The only shape check on the response, and it is a shape check rather than a parse: this page
 * must not become a second schema for a payload `@crucible/frame` already owns. Anything that is
 * not a replay is an unreadable answer, said out loud, rather than a half-rendered rail.
 */
function asReplay(body: unknown): { replay: Replay; meta: ReplayMeta } | null {
  if (typeof body !== "object" || body === null) return null;
  const candidate = body as { data?: unknown; meta?: unknown };
  const data = candidate.data;
  const meta = candidate.meta;
  if (typeof data !== "object" || data === null) return null;
  const frames = (data as { frames?: unknown }).frames;
  if (!Array.isArray(frames)) return null;
  if (typeof meta !== "object" || meta === null) return null;
  const range = (meta as { range?: unknown }).range;
  if (typeof range !== "object" || range === null) return null;
  const { fromBlock, toBlock } = range as { fromBlock?: unknown; toBlock?: unknown };
  if (typeof fromBlock !== "number" || typeof toBlock !== "number") return null;
  const m = meta as { trialId?: unknown; logsFound?: unknown; logsUndecoded?: unknown; beforeWindow?: unknown };
  if (
    typeof m.trialId !== "number" ||
    typeof m.logsFound !== "number" ||
    typeof m.logsUndecoded !== "number" ||
    typeof m.beforeWindow !== "boolean"
  ) {
    return null;
  }
  return {
    replay: data as Replay,
    meta: {
      trialId: m.trialId,
      logsFound: m.logsFound,
      logsUndecoded: m.logsUndecoded,
      range: { fromBlock, toBlock },
      beforeWindow: m.beforeWindow,
    },
  };
}
