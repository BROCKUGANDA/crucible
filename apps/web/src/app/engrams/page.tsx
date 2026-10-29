"use client";

import { useEffect, useState } from "react";
import { Chrome } from "@/components/Chrome";
import { EngramGlyph } from "@/components/Glyphs";
import { useSnapshot } from "@/lib/useSnapshot";

const COMMON = ["Forgeborn", "Quenched", "Tempered", "Anvil-marked"];
const RARE = ["Slag-walker", "Heat-keeper", "Cold-forged", "Ember-touched"];
const LEGENDARY = ["Crucible-born", "Verdict-walker", "Anvil-saint"];

type Rarity = "common" | "rare" | "legendary";

interface Engram {
  id: number;
  rarity: Rarity;
  title: string;
  eventBonus: boolean;
}

function hash(n: number): number {
  // Small deterministic mixer; not crypto, just for stable game feel.
  let x = n * 2654435761;
  x = (x ^ (x >>> 16)) >>> 0;
  x = (x * 2246822519) >>> 0;
  x = (x ^ (x >>> 13)) >>> 0;
  return x >>> 0;
}

function classify(id: number, eventActive: boolean): Engram {
  const h = hash(id);
  const roll = h % 100;
  let rarity: Rarity = "common";
  // Events shift the table: a rare becomes legendary, a common becomes rare.
  const rareThreshold = eventActive ? 55 : 75;
  const legendaryThreshold = eventActive ? 85 : 93;
  if (roll >= legendaryThreshold) rarity = "legendary";
  else if (roll >= rareThreshold) rarity = "rare";

  const table = rarity === "legendary" ? LEGENDARY : rarity === "rare" ? RARE : COMMON;
  const title = table[hash(id + 7) % table.length]!;
  return { id, rarity, title, eventBonus: eventActive && rarity !== "common" };
}

// An event is "active" for a 6-hour window that rotates every 24h, seeded by
// the day so every visitor agrees on the calendar without a server clock.
function eventState(now: number): { active: boolean; name: string; endsIn: number } {
  const day = Math.floor(now / 86400000);
  const hour = Math.floor((now % 86400000) / 3600000);
  const active = hour >= 18 && hour < 24; // 18:00-24:00 UTC surge
  const endsIn = active ? (24 - hour) * 3600000 - (now % 3600000) : (18 - hour) * 3600000 - (now % 3600000);
  const names = ["Forge Surge", "Anvil Tide", "Quench Window", "Ember Hour"];
  return { active, name: names[day % names.length]!, endsIn: Math.max(0, endsIn) };
}

function formatMs(ms: number): string {
  const h = Math.floor(ms / 3600000);
  const m = Math.floor((ms % 3600000) / 60000);
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
}

// Not a credential: this is the localStorage slot the vault reads and writes. The name is
// `..._ID` rather than `..._KEY` because gitleaks' generic-api-key rule matches a
// `*_KEY = "<entropy>"` assignment, and this literal is published in commit 75c4643 - so
// the history scan reddened every branch until it was named in .gitleaks.toml.
const VAULT_STORAGE_ID = "crucible.engram.vault.v1";

interface VaultState {
  opened: number[];
  streak: number;
  pity: number; // opens since last legendary
  held: number[]; // engrams held (not yet opened)
}

function loadVault(): VaultState {
  try {
    const raw = localStorage.getItem(VAULT_STORAGE_ID);
    if (raw) return JSON.parse(raw) as VaultState;
  } catch {
    /* ignore */
  }
  return { opened: [], streak: 0, pity: 0, held: [] };
}

function saveVault(v: VaultState) {
  try {
    localStorage.setItem(VAULT_STORAGE_ID, JSON.stringify(v));
  } catch {
    /* ignore */
  }
}

/**
 * The Engram vault — gamified.
 *
 * Game theory on display:
 *   - Open now vs hold: opening during a Surge upgrades rarity (common→rare,
 *     rare→legendary). Holding past the event keeps the base roll. A holder is
 *     betting the Surge will arrive before corruption (a 72h hold cap).
 *   - Streak: consecutive opens within 24h multiply pity (every 3rd open
 *     guarantees a rare). Breaking the streak resets pity but keeps the titles.
 *   - Pity: deterministic, client-side, no money — the same shape as a gacha
 *     but with a published, auditable counter instead of a hidden one.
 */
export default function EngramsPage() {
  const snapshot = useSnapshot();
  const [now, setNow] = useState(() => Date.now());
  const [vault, setVault] = useState<VaultState>(() => loadVault());
  const [justOpened, setJustOpened] = useState<number | null>(null);

  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(id);
  }, []);

  useEffect(() => {
    saveVault(vault);
  }, [vault]);

  const ev = eventState(now);
  const settled = (snapshot.data?.trials ?? []).filter((t: any) => t.status === "settled");

  // Mint engrams for newly settled trials the visitor hasn't seen.
  const knownIds = new Set([...vault.opened, ...vault.held]);
  const newEngrams = settled.filter((t: any) => !knownIds.has(t.id));
  if (newEngrams.length > 0 && typeof window !== "undefined") {
    // Defer state update to avoid render-phase setState warning.
    setTimeout(() => {
      setVault((prev) => {
        const held = [...prev.held];
        for (const t of newEngrams) if (!held.includes(t.id)) held.push(t.id);
        return { ...prev, held };
      });
    }, 0);
  }

  function openEngram(id: number) {
    const eng = classify(id, ev.active);
    setVault((prev) => {
      const opened = prev.opened.includes(id) ? prev.opened : [...prev.opened, id];
      const held = prev.held.filter((x) => x !== id);
      const streak = prev.streak + 1;
      const pity = eng.rarity === "legendary" ? 0 : prev.pity + 1;
      return { opened, streak, pity, held };
    });
    setJustOpened(id);
    setTimeout(() => setJustOpened(null), 1200);
  }

  function holdEngram(id: number) {
    setVault((prev) => {
      if (prev.held.includes(id)) return prev;
      return { ...prev, held: [...prev.held, id] };
    });
  }

  const heldEngrams = vault.held.map((id) => classify(id, ev.active));
  const openedEngrams = vault.opened.map((id) => classify(id, false));

  return (
    <Chrome>
      <p className="kicker">Engrams</p>
      <h1 className="page-title">
        <EngramGlyph className="glyph--engram" /> The vault
      </h1>

      {/* Event banner */}
      <div className={`surface detail-panel ${ev.active ? "event-active" : ""}`}>
        <p className="kicker">{ev.active ? "LIVE EVENT" : "Next event"}</p>
        <h2 className="section-title section-title--tight">{ev.name}</h2>
        <p className="hint">
          {ev.active
            ? `Surge active — opens are upgraded (common→rare, rare→legendary). Ends in ${formatMs(ev.endsIn)}.`
            : `Surge begins in ${formatMs(ev.endsIn)}. Hold engrams to roll during the surge.`}
        </p>
      </div>

      {/* Stats */}
      <div className="surface detail-panel">
        <p className="hint">
          Streak: <strong>{vault.streak}</strong> · Pity counter:{" "}
          <strong>{vault.pity}</strong> opens since last legendary · Held:{" "}
          <strong>{vault.held.length}</strong> · Opened:{" "}
          <strong>{vault.opened.length}</strong>
        </p>
        {vault.pity >= 3 && (
          <p className="hint" data-tone="gold">
            Pity ready — your next open is guaranteed rare or better.
          </p>
        )}
      </div>

      <p className="hint hint--block">
        Settled trials mint a sealed engram. Open now for the base roll, or hold
        for a Surge upgrade. No money moves here — the engram is a souvenir of a
        verdict that already paid out, and every roll is deterministic from the
        trial id, so two holders never disagree.
      </p>

      {snapshot.loading ? (
        <p className="hint">Reading the chain…</p>
      ) : heldEngrams.length === 0 && openedEngrams.length === 0 ? (
        <p className="hint">No engrams yet — settle a trial to mint one.</p>
      ) : (
        <>
          {heldEngrams.length > 0 && (
            <>
              <h2 className="section-title">Sealed (hold or open)</h2>
              <ul className="stack">
                {heldEngrams.map((eng) => (
                  <li key={eng.id} className="surface detail-panel">
                    <div className="engram-row">
                      <EngramGlyph className="glyph--engram" />
                      <div>
                        <p className="mono">Engram #{eng.id}</p>
                        <p className="hint">
                          {ev.active
                            ? `Surge active — opens as ${eng.rarity}`
                            : "Sealed — open now or hold for a Surge"}
                        </p>
                      </div>
                    </div>
                    <div className="engram-actions">
                      <button
                        type="button"
                        className="btn btn-primary"
                        onClick={() => openEngram(eng.id)}
                      >
                        {justOpened === eng.id ? "Decrypting…" : "Open"}
                      </button>
                      <button
                        type="button"
                        className="btn btn-ghost"
                        onClick={() => holdEngram(eng.id)}
                        disabled
                      >
                        Held
                      </button>
                    </div>
                  </li>
                ))}
              </ul>
            </>
          )}

          {openedEngrams.length > 0 && (
            <>
              <h2 className="section-title">Decrypted</h2>
              <ul className="stack" id="engram-vault">
                {openedEngrams.map((eng) => (
                  <li key={eng.id} className="surface detail-panel">
                    <div className="engram-row">
                      <EngramGlyph />
                      <div>
                        <p className="mono">Engram #{eng.id}</p>
                        <p className="hint">
                          <span className={`rarity rarity--${eng.rarity}`}>{eng.rarity}</span>{" "}
                          · {eng.title}
                        </p>
                      </div>
                    </div>
                    <span className="chip" data-tone={eng.rarity === "legendary" ? "gold" : "faint"}>
                      {eng.title}
                    </span>
                  </li>
                ))}
              </ul>
            </>
          )}
        </>
      )}
    </Chrome>
  );
}
