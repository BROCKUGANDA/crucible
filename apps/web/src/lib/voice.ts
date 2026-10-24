/**
 * Frenchy's client-side policy.
 *
 * The rule is deliberately boring: the host is off until someone asks for it, it never
 * speaks automatically more than once a day, and it never speaks on a failure. The
 * server owns the words; this file owns when a word is allowed.
 *
 * Every storage read is guarded, because this runs during prerender where `window`
 * does not exist. A voice host that breaks the page it decorates is worse than no host.
 */

import { API_BASE } from "./apiBase";

export type VoiceMoment = "greeting" | "tour" | "verdict" | "verdict-repeat" | "spec";
export const VOICE_ENABLED_KEY = "crucible.voice.enabled";
export const VOICE_DAY_KEY = "crucible.voice.lastDay";
export const VOICE_CATCHPHRASE_KEY = "crucible.voice.catchphrase";

export interface VoicePrefs {
  enabled: boolean;
  lastDay: string | null;
  catchphraseUsed: boolean;
}

/** The user's local calendar day, not UTC: "once a day" means their day. */
export function localDay(now: Date = new Date()): string {
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, "0");
  const d = String(now.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

type Reader = Pick<Storage, "getItem">;

export function readVoicePrefs(storage: Reader | null | undefined): VoicePrefs {
  return {
    enabled: storage?.getItem(VOICE_ENABLED_KEY) === "1",
    lastDay: storage?.getItem(VOICE_DAY_KEY) ?? null,
    catchphraseUsed: storage?.getItem(VOICE_CATCHPHRASE_KEY) === "1",
  };
}

export function writeVoiceEnabled(storage: Storage | null | undefined, enabled: boolean): void {
  try {
    storage?.setItem(VOICE_ENABLED_KEY, enabled ? "1" : "0");
  } catch {
    /* private mode / quota: the in-memory state still works for this page */
  }
}

export function markSpoken(storage: Storage | null | undefined, day: string): void {
  try {
    storage?.setItem(VOICE_DAY_KEY, day);
  } catch {
    /* see writeVoiceEnabled */
  }
}

export function markCatchphrase(storage: Storage | null | undefined): void {
  try {
    storage?.setItem(VOICE_CATCHPHRASE_KEY, "1");
  } catch {
    /* see writeVoiceEnabled */
  }
}

/**
 * Auto speech is allowed only when the host is on, the user has not asked for reduced
 * motion, and nothing has been spoken today. A manual request (the unmute click, the
 * tour button) bypasses the daily cap because the user just asked for it, but still
 * requires the host to be on.
 */
export function shouldSpeak(args: {
  enabled: boolean;
  reducedMotion: boolean;
  lastDay: string | null;
  today: string;
  manual?: boolean;
}): boolean {
  if (!args.enabled) return false;
  if (args.manual) return true;
  return !args.reducedMotion && args.lastDay !== args.today;
}

/** The catchphrase is used exactly once per browser session. */
export function verdictMoment(catchphraseUsed: boolean): VoiceMoment {
  return catchphraseUsed ? "verdict-repeat" : "verdict";
}

/** Whether the server has a key and a voice id. Never returns the key. */
export async function fetchVoiceStatus(): Promise<boolean> {
  try {
    const res = await fetch(`${API_BASE}/voice/status`, { method: "GET" });
    if (!res.ok) return false;
    const body = (await res.json()) as { configured?: unknown };
    return body.configured === true;
  } catch {
    return false;
  }
}

/**
 * Ask the server for a clip. A null answer used to be the normal failure, which made every
 * failure identical: a dead provider, a 429, an empty body and a CSP that refuses to play
 * the bytes all looked the same from the caller. The reason travels with the answer.
 */
export type VoiceClip = { ok: true; blob: Blob } | { ok: false; reason: string };

/**
 * One clip per line, kept for the session.
 *
 * Frenchy's copy is fixed — the greeting is the same greeting — so fetching it again on
 * every turn paid a round trip and a synthesis for bytes this tab already had. The same
 * map dedupes concurrent requests: the toggle, the return-visit effect and a page's
 * announcement can all ask for the greeting in one tick, and before this they each opened
 * their own request and the host could start twice.
 *
 * Bounded by construction: the moments are a closed set of five, and `spec` is the only
 * one that takes caller text (capped at 600 characters by the API). A failure is never
 * cached — a dead provider must be retried next time, not remembered forever.
 */
const clips = new Map<string, VoiceClip>();
const inflight = new Map<string, Promise<VoiceClip>>();

function clipKey(moment: VoiceMoment, text?: string): string {
  return text === undefined ? moment : `${moment}\u0000${text}`;
}

async function requestClip(moment: VoiceMoment, text?: string): Promise<VoiceClip> {
  let res: Response;
  try {
    res = await fetch(`${API_BASE}/voice/speak`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(text === undefined ? { moment } : { moment, text }),
    });
  } catch {
    return { ok: false, reason: "the voice server could not be reached" };
  }
  if (!res.ok) return { ok: false, reason: `the voice server answered ${res.status}` };
  const blob = await res.blob().catch(() => null);
  if (!blob || blob.size === 0) return { ok: false, reason: "the clip arrived empty" };
  return { ok: true, blob };
}

export async function fetchVoiceClip(moment: VoiceMoment, text?: string): Promise<VoiceClip> {
  const key = clipKey(moment, text);
  const cached = clips.get(key);
  if (cached) return cached;
  const pending = inflight.get(key);
  if (pending) return pending;

  const request = requestClip(moment, text).then((clip) => {
    inflight.delete(key);
    if (clip.ok) clips.set(key, clip);
    return clip;
  });
  inflight.set(key, request);
  return request;
}

/**
 * Warms a line without playing it.
 *
 * Called when Frenchy is already on, so the greeting a returning visitor hears is not
 * waiting behind a synthesis it did not ask for. Fetching is not playing: no autoplay
 * policy is involved, and a failure here is silence like every other one.
 */
export async function prefetchVoiceClip(moment: VoiceMoment): Promise<void> {
  await fetchVoiceClip(moment);
}

// ── the one event the pages emit ─────────────────────────────────────────
//
// Trial pages do not own the voice control (it lives in Chrome and survives route
// changes), so they announce the moment and the control decides whether it is allowed.

type Listener = (moment: VoiceMoment) => void;
const listeners = new Set<Listener>();

export function announceVoice(moment: VoiceMoment): void {
  for (const listener of [...listeners]) listener(moment);
}

export function subscribeVoice(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
