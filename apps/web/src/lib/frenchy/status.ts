/**
 * Does this host have Frenchy's brain?
 *
 * The control must not appear on a host that cannot answer: a microphone button whose every
 * sentence comes back "Frenchy is momentarily indisposed" teaches the visitor that the site is
 * broken. `VoiceControl` solves the identical problem for text-to-speech by reading
 * `GET /voice/status`; the brain asks the same way now: `GET /frenchy/status` answers 200 with
 * a brain and 503 without, and neither path reaches a provider, so the question never costs a
 * cent. (It used to probe by POSTing an empty body and reading the 400 as "configured" —
 * same answer, but a 400 in every visitor's console on every page load.)
 *
 * Everything else — an API older than this route, a network failure, a dead host — is "not
 * shown", which is the safe answer: this function can only ever hide a button.
 */

import { API_BASE } from "../apiBase";

const UNCONFIGURED = 503;
const TOO_MANY = 429;

export async function fetchFrenchyBrainStatus(): Promise<boolean> {
  let res: Response;
  try {
    res = await fetch(`${API_BASE}/frenchy/status`, { method: "GET" });
  } catch {
    return false;
  }

  if (res.status === UNCONFIGURED) return false;
  // A 429 still counts as a brain: only a host with one puts a limiter in front of the
  // route, and a visitor being throttled should see the control, not lose it.
  return res.ok || res.status === TOO_MANY;
}
