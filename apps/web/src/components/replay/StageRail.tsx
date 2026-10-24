"use client";

import { useRef, type KeyboardEvent } from "react";
import type { RailRow } from "@/lib/replay/view";

/**
 * The rail: every beat, in chain order, with a cursor you can drive from the keyboard.
 *
 * Holds no rules. The rows arrive already labelled by `lib/replay/view.ts`, and the only
 * decision made here is where the focus ring goes when a key is pressed.
 *
 * Roving tabindex rather than `aria-activedescendant`: one keystroke moves both the focus and
 * the selected beat, which is what the sibling trial page already does with its tabs, so the
 * two pages do not teach two different keyboard habits. The arrows are clamped, not wrapped,
 * because the scrub bar under this rail cannot wrap — two controls over one cursor must not
 * disagree about where the ends are.
 */

export interface StageRailProps {
  rows: RailRow[];
  /** index into `rows`, not a frame number: a frame's own `n` is on the row */
  cursor: number;
  onCursor: (index: number) => void;
}

export function StageRail({ rows, cursor, onCursor }: StageRailProps) {
  const refs = useRef<(HTMLDivElement | null)[]>([]);

  function onKeyDown(e: KeyboardEvent<HTMLDivElement>, i: number) {
    let next: number;
    if (e.key === "ArrowDown") next = Math.min(rows.length - 1, i + 1);
    else if (e.key === "ArrowUp") next = Math.max(0, i - 1);
    else if (e.key === "Home") next = 0;
    else if (e.key === "End") next = rows.length - 1;
    else return;
    // PageDown/PageUp and the arrows belong to the rail while a beat has focus; without this
    // the same keystroke also scrolls the document and the reader loses the row they were on.
    e.preventDefault();
    if (next === i) return;
    onCursor(next);
    refs.current[next]?.focus();
  }

  return (
    <div className="stack">
      <h2 className="section-title section-title--tight">The beats</h2>
      <div role="listbox" aria-label="Beats this trial left on the chain" className="stack">
        {rows.map((row, i) => {
          const selected = i === cursor;
          return (
            <div
              key={row.frameHash}
              ref={(el) => {
                refs.current[i] = el;
              }}
              role="option"
              aria-selected={selected}
              aria-current={selected ? "step" : undefined}
              aria-label={describe(row, selected)}
              tabIndex={selected ? 0 : -1}
              className="row"
              onClick={() => onCursor(i)}
              onKeyDown={(e) => onKeyDown(e, i)}
            >
              <span className="kicker" data-tone={selected ? "gold" : "faint"}>
                beat {row.n}
              </span>
              <span data-tone={selected ? "text" : "dim"}>{row.label}</span>
              <span className="kicker figures">block {row.block}</span>
              {/* Both facts are in the markup, not only in a colour: a row you can tell apart
                  just by hue is a row you have not read. */}
              {row.speakable ? (
                <span className="chip" data-tone="faint">
                  Frenchy
                </span>
              ) : null}
              {selected ? (
                <span className="chip" data-tone="gold">
                  here
                </span>
              ) : null}
            </div>
          );
        })}
      </div>
      <p className="hint hint--block">
        “Frenchy” marks a beat the forge&apos;s AI host is allowed to comment on. A beat without it
        stays silent, however long you sit on it.
      </p>
    </div>
  );
}

/**
 * What a screen reader is told about one beat. Assembled here because it is a reading of this
 * row's own fields, not a rule about the replay: the sentence, the block and the two marks are
 * already on the row.
 */
function describe(row: RailRow, selected: boolean): string {
  const speak = row.speakable ? "Frenchy may speak on this beat." : "No commentary on this beat.";
  const here = selected ? " Selected." : "";
  return `Beat ${row.n}. ${row.label} Block ${row.block}.${here} ${speak}`;
}
