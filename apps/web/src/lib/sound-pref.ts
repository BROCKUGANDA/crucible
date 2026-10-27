import { browserAudioContext, createMoneySound, motifSeconds } from "./money-sound";

/**
 * The one place that knows whether the site is allowed to make a sound, and how.
 *
 * A second source of truth beside the voice policy is exactly what AGENTS.md forbids, so the two
 * rules are stated as one: Frenchy speaks only when the visitor asked (`lib/voice.ts`), and the
 * motif plays only when the visitor turned this switch on. Both are opt-in, both survive a
 * reload, and neither can start on a page load the visitor did not act on.
 *
 * `celebrate()` is the call a page makes when something the visitor did landed — a trial paid, a
 * withdrawal taken. It is fire-and-forget and returns nothing, because a page's job is not to
 * care whether audio was available.
 */

const SOUND_KEY = "crucible.sound";

/** Stored as the word `on`, so no legacy value can read as consent. */
export function isSoundEnabled(): boolean {
  if (typeof window === "undefined") return false;
  try {
    return window.localStorage.getItem(SOUND_KEY) === "on";
  } catch {
    return false;
  }
}

export function setSoundEnabled(on: boolean): void {
  try {
    if (on) window.localStorage.setItem(SOUND_KEY, "on");
    else window.localStorage.removeItem(SOUND_KEY);
  } catch {
    // Storage blocked (private mode): the switch still works for this page view. A preference
    // that cannot be saved is not a reason to refuse the sound the visitor just asked for.
  }
}

// One context for the whole page. `useMemo` per component would build a second one per mount,
// and a second context is a second audio graph to leak when the route changes.
let player: ReturnType<typeof createMoneySound> | null = null;
let lastPlayAt = -Infinity;

function audio(): ReturnType<typeof createMoneySound> {
  if (!player) player = createMoneySound(browserAudioContext());
  return player;
}

/** True when this browser can make the sound at all, so the control can hide itself. */
export function soundSupported(): boolean {
  return typeof window !== "undefined" && Boolean(browserAudioContext());
}

/**
 * Play the motif if the visitor enabled it. Returns whether it played, for the caller that wants
 * to say so on screen.
 *
 * The guard against overlapping plays is measured, not guessed: `motifSeconds()` is the length of
 * the note list, so a second celebration inside the motif layers a second copy of the same
 * arpeggio and the effect that reads as a payout starts reading as a glitch.
 */
export function celebrate(now: () => number = () => Date.now()): boolean {
  if (!isSoundEnabled()) return false;
  const t = now();
  if (t - lastPlayAt < motifSeconds() * 1000) return false;
  lastPlayAt = t;
  return audio().play();
}

/** A short strike for a moment that is notable but not a payday. */
export function strike(): boolean {
  if (!isSoundEnabled()) return false;
  return audio().strike();
}

/** Release the audio context. Called by the control that owns the switch, on unmount. */
export function disposeSound(): void {
  const p = player;
  player = null;
  if (p) p.dispose();
}
