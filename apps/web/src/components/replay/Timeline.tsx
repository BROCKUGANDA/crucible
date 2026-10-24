"use client";

import type { ChangeEvent } from "react";
import { shortHash } from "@/lib/forge";
import { orDash, type RailRow } from "@/lib/replay/view";

/**
 * The scrub bar: one position over the beats, and the sentence for whatever is under it.
 *
 * A native range input, because it arrives with the keyboard, the pointer, the screen-reader
 * value announcement and the ends already correct, and every substitute written by hand gets one
 * of those wrong. The act boundaries are the row of marks under it: one per run of beats that
 * share a moment, labelled with the beat it starts on and how many beats that run holds.
 *
 * It fetches nothing and derives no rule. Runs are grouped by `moment` here because that is the
 * shape a ruler needs; the words themselves all come from the row.
 */

export interface TimelineProps {
  rows: RailRow[];
  cursor: number;
  onCursor: (index: number) => void;
}

interface Boundary {
  /** index into `rows` where this run of beats starts */
  start: number;
  beats: number;
  moment: RailRow["moment"];
}

export function Timeline({ rows, cursor, onCursor }: TimelineProps) {
  const selected = rows[cursor];
  const last = Math.max(0, rows.length - 1);
  const boundaries = runs(rows);

  return (
    <div className="surface detail-panel">
      <h2 className="section-title section-title--tight">Where you are</h2>

      <input
        className="input"
        type="range"
        min={0}
        max={last}
        step={1}
        value={Math.min(cursor, last)}
        aria-label="Scrub the replay beat by beat"
        aria-valuetext={
          selected
            ? `beat ${selected.n} of ${rows.length}: ${selected.label}`
            : `${rows.length} beats`
        }
        onChange={(e: ChangeEvent<HTMLInputElement>) => onCursor(Number(e.target.value))}
      />

      <div className="row" role="group" aria-label="Act boundaries">
        {boundaries.map((b) => {
          const row = rows[b.start];
          if (!row) return null;
          const inRun = cursor >= b.start && cursor < b.start + b.beats;
          return (
            <button
              key={row.frameHash}
              type="button"
              className="filter-chip"
              data-selected={inRun || undefined}
              aria-label={`Go to beat ${row.n}, block ${row.block}, ${b.beats} ${b.beats === 1 ? "beat" : "beats"}`}
              onClick={() => onCursor(b.start)}
            >
              beat {row.n}
              <span className="filter-chip__count">{b.beats}</span>
            </button>
          );
        })}
      </div>

      {/* The caption line. Anything the frame does not carry prints as an em dash — never as a
          zero, never as a blank, because a reader cannot tell the two apart from the page. */}
      <p className="hint hint--block">
        <span className="mono">{orDash(selected?.what)}</span>{" "}
        <span className="mono figures">
          block {selected === undefined ? orDash(null) : selected.block}
        </span>{" "}
        <span className="mono">recorded by {shortHash(selected?.actor)}</span>
      </p>
    </div>
  );
}

/** Runs of consecutive beats sharing a moment, in order. Presentation arithmetic only. */
function runs(rows: RailRow[]): Boundary[] {
  const out: Boundary[] = [];
  for (const [i, row] of rows.entries()) {
    const last = out[out.length - 1];
    if (last && last.moment === row.moment) {
      last.beats += 1;
      continue;
    }
    out.push({ start: i, beats: 1, moment: row.moment });
  }
  return out;
}
