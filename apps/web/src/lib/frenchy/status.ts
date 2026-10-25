/**
 * Does this host have Frenchy's brain?
 *
 * The control must not appear on a host that cannot answer: a microphone button whose every
 * sentence comes back "Frenchy is momentarily indisposed" teaches the visitor that the site is
 * broken. `VoiceControl` solves the identical problem for text-to-speech by reading
 * `GET /voice/status`; the brain has no such route, and adding one to the API is not this
 * file's decision. What the brain *does* have is an ordering that makes the question cheap to
 * ask: `POST /frenchy` checks its configuration before it reads the body, so an empty body
 * answers `503 "Frenchy's brain is not configured"` on a host without a key and `400 "prompt
 * is required"` on one with a key. Neither path reaches a provider, so neither costs a cent —
 * the request that asks whether the LLM exists never calls the LLM.
 *
 * A 429 counts as configured: only a host with a brain puts a limiter in front of this route,
 * and a visitor who is being throttled should see the control, not lose it.
 *
 * Everything else — a 404 from an API older than this route, a network failure, a dead host —
 * is "not shown", which is the safe answer: this function can only ever hide a button.
 */

import { API_BASE } from "../apiBase";

const UNCONFIGURED = 503;
const UNKNOWN_PROMPT = 400;
const TOO_MANY = 429;
const UPSTREAM_FAILURE = 502;

export async function fetchFrenchyBrainStatus(): Promise<boolean> {
  let res: Response;
  try {
    res = await fetch(`${API_BASE}/frenchy`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });
  } catch {
    return false;
  }

  if (res.status === UNCONFIGURED) return false;
  const known =
    res.status === UNKNOWN_PROMPT || res.status === TOO_MANY || res.status === UPSTREAM_FAILURE;
  return known || res.ok;
}
