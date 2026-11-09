"use client";

import { useEffect, useState } from "react";
import { Chrome } from "@/components/Chrome";
import { EngramGlyph } from "@/components/Glyphs";
import { useSnapshot } from "@/lib/useSnapshot";
import { API_BASE } from "@/lib/apiBase";
import { formatDuration } from "@/lib/forge";
import { useAccount } from "wagmi";

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

interface Entitlement {
  entitlementId: string;
  recipient: string;
  ruleId: string;
  ruleVersion: number;
  tokenId: number;
  amount: number;
  eventId: string;
  evidenceRef: string;
  issuedAt: number;
}

const VAULT_STORAGE_ID = "crucible.engram.vault.v1";

function loadOpened(): number[] {
  try {
    const raw = localStorage.getItem(VAULT_STORAGE_ID);
    if (raw) return (JSON.parse(raw) as { opened: number[] }).opened ?? [];
  } catch {
    /* ignore */
  }
  return [];
}

function saveOpened(opened: number[]) {
  try {
    localStorage.setItem(VAULT_STORAGE_ID, JSON.stringify({ opened }));
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
  const { address } = useAccount();
  const [now, setNow] = useState(() => Date.now());
  const [entitlements, setEntitlements] = useState<Entitlement[]>([]);
  const [opened, setOpened] = useState<number[]>(() => loadOpened());
  const [apiError, setApiError] = useState<string | null>(null);
  const [justOpened, setJustOpened] = useState<number | null>(null);

  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(id);
  }, []);

  useEffect(() => {
    saveOpened(opened);
  }, [opened]);

  useEffect(() => {
    if (!address) {
      setEntitlements([]);
      setApiError(null);
      return;
    }
    let cancelled = false;
    fetch(`${API_BASE}/engrams/${encodeURIComponent(address)}`, {
      credentials: "include",
      headers: { Accept: "application/json" },
    })
      .then(async (res) => {
        if (!res.ok) throw new Error(`API ${res.status}`);
        return (await res.json()) as { entitlements?: Entitlement[] };
      })
      .then((data) => {
        if (!cancelled) setEntitlements(data.entitlements ?? []);
      })
      .catch((err) => {
        if (!cancelled) {
          setApiError(err.message);
          setEntitlements([]);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [address]);

  const ev = eventState(now);
  const settled = (snapshot.data?.trials ?? []).filter((t: any) => t.status === "settled");
  const knownTokenIds = new Set(entitlements.map((e) => e.tokenId));
  const newEngramIds = settled.filter((t: any) => !knownTokenIds.has(t.id)).map((t: any) => t.id);
  // This used to run during render behind a setTimeout(…, 0): a state update scheduled
  // from the render path itself, re-scheduled on every pass. The effect runs after commit
  // and is keyed on the serialized ids, so it fires once per newly settled trial.
  const newEngramKey = newEngramIds.join(",");
  useEffect(() => {
    if (!newEngramKey) return;
    setOpened((prev) => {
      const held = [...prev];
      for (const id of newEngramIds) if (!held.includes(id)) held.push(id);
      return held;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- the serialized ids are the key
  }, [newEngramKey]);

  const ownedIds = [...new Set([...entitlements.map((e) => e.tokenId), ...opened])];
  const heldEngrams = ownedIds
    .filter((id) => !opened.includes(id))
    .map((id) => classify(id, ev.active));
  const openedEngrams = opened.map((id) => classify(id, false));

  function openEngram(id: number) {
    if (opened.includes(id)) return;
    setOpened((prev) => [...prev, id]);
    setJustOpened(id);
    setTimeout(() => setJustOpened(null), 1200);
  }

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
            ? `Surge active — opens are upgraded (common→rare, rare→legendary). Ends in ${formatDuration(Math.ceil(ev.endsIn / 1000))}.`
            : `Surge begins in ${formatDuration(Math.ceil(ev.endsIn / 1000))}. Hold engrams to roll during the surge.`}
        </p>
      </div>

      <div className="surface detail-panel">
        <p className="hint hint--block">
          Held: <strong>{heldEngrams.length}</strong> · Opened:{" "}
          <strong>{openedEngrams.length}</strong> · Entitlements:{" "}
          <strong>{entitlements.length}</strong>
        </p>
        <p className="hint hint--block" data-tone="faint">
          Demo vault: rarity, titles and Surge come from a local deterministic
          mixer for preview only. Real achievement state is the verified
          entitlement list above plus on-chain ERC-1155 balances. Do not treat a
          sealed entry as a minted NFT.
        </p>
      </div>

      {!address ? (
        <p className="hint hint--block">Connect a wallet and sign in with SIWE to see your verified entitlements (session-gated).</p>
      ) : apiError ? (
        <p className="hint hint--block">Entitlements unavailable ({apiError}). Showing local vault only.</p>
      ) : null}

      <p className="hint hint--block">
        Settled trials mint a sealed engram. Open now for the base roll, or hold
        for a Surge upgrade. Ownership comes from the API (verified
        entitlements); open/hold state is kept locally. Claim real entitlements
        under <a href="/rewards">/rewards</a> — this page does not mint.
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
