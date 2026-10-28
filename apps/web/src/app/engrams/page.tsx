"use client";

import { useState } from "react";
import { Chrome } from "@/components/Chrome";
import { EngramGlyph } from "@/components/Glyphs";
import { useSnapshot } from "@/lib/useSnapshot";

const TITLES = [
  "Forgeborn",
  "Quenched",
  "Tempered",
  "Anvil-marked",
  "Slag-walker",
  "Heat-keeper",
  "Cold-forged",
  "Ember-touched",
];

function titleFor(id: number): string {
  return TITLES[id % TITLES.length]!;
}

/**
 * The Engram vault.
 *
 * Every settled trial mints a sealed engram — a deterministic, cosmetic reward
 * (a title) that the holder "decrypts" with a tap. No money moves: the engram
 * is garnish on a verdict that already paid out, and the title is derived from
 * the trial id so two holders never disagree about what an engram contained.
 */
export default function EngramsPage() {
  const snapshot = useSnapshot();
  const [opened, setOpened] = useState<Set<number>>(new Set());

  const settled = (snapshot.data?.trials ?? []).filter((t: any) => t.status === "settled");

  return (
    <Chrome>
      <p className="kicker">Engrams</p>
      <h1 className="page-title">
        <EngramGlyph className="glyph--engram" /> The vault
      </h1>
      <p className="hint hint--block">
        Settled trials mint a sealed engram. Open one to decrypt its title. No
        money moves here — the engram is a souvenir of a verdict that already
        paid out, and the title is derived from the trial id, so it never
        changes.
      </p>

      {snapshot.loading ? (
        <p className="hint">Reading the chain…</p>
      ) : settled.length === 0 ? (
        <p className="hint">No engrams yet — settle a trial to mint one.</p>
      ) : (
        <ul className="stack">
          {settled.map((t: any) => {
            const isOpen = opened.has(t.id);
            return (
              <li key={t.id} className="surface detail-panel">
                <div style={{ display: "flex", alignItems: "center", gap: "0.75rem" }}>
                  <EngramGlyph className={isOpen ? "" : "glyph--engram"} />
                  <div>
                    <p className="mono">Engram #{t.id}</p>
                    <p className="hint">
                      {isOpen ? `Decrypted: ${titleFor(t.id)}` : "Sealed — tap to decrypt"}
                    </p>
                  </div>
                </div>
                {!isOpen ? (
                  <button
                    type="button"
                    className="btn btn-primary"
                    onClick={() => setOpened((prev) => new Set(prev).add(t.id))}
                  >
                    Decrypt
                  </button>
                ) : (
                  <span className="chip" data-tone="gold">
                    {titleFor(t.id)}
                  </span>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </Chrome>
  );
}
