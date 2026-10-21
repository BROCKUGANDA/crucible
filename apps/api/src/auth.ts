/**
 * @file auth.ts — Sign-In with Ethereum, as the API's optional session layer.
 *
 * Ported from the parallel Scaffold-ETH 2 build (`packages/nextjs/services/auth/*` +
 * `app/api/auth/*`), which is being merged into this app. Two things were kept exactly
 * as they were, because they are the properties that make the flow idempotent rather
 * than merely correct:
 *
 *   1. **The challenge message is stored, never rebuilt.** Verification recovers the
 *      signer against the bytes the server issued, so a client that re-renders the
 *      message differently — a trailing newline, a different clock — fails closed
 *      instead of silently signing something else.
 *   2. **A consumed challenge remembers its session.** Replaying `{address, nonce,
 *      signature}` (a retried POST, a double-clicked button) returns the byte-identical
 *      cookie rather than an error, which is the only behaviour a wallet on a flaky
 *      phone can actually rely on.
 *
 * What changed for this codebase: `next/headers` cookies become explicit `Set-Cookie`
 * headers on the Hono response, the four route handlers become one `authRoutes()` app
 * mounted under `/auth`, and the SE-2 guards module's rate limiting is not ported
 * because this API already rate-limits every request in its middleware chain (see
 * `app.ts`).
 *
 * The one thing that changed in substance: **the origin in the challenge message is
 * configured, not derived from the request.** See `configuredOrigin`.
 */
import { Hono } from "hono";
import type { Context } from "hono";
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { keccak256, recoverAddress, recoverMessageAddress, toBytes } from "viem";

const CHALLENGE_TTL_MS = 5 * 60_000;
const CONSUMED_TTL_MS = 10 * 60_000;
const MAX_ENTRIES = 5_000;
const COOKIE_NAME = "crucible_session";
const SESSION_TTL_SECONDS = 60 * 60 * 24 * 7;
const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;
const HEX_RE = /^0x[0-9a-fA-F]+$/;

/**
 * The development secret. It is public, so it is only ever used when a
 * deployment has explicitly asked for it.
 */
const DEV_SECRET = "crucible-local-dev-secret-not-for-production";

export type SessionPayload = {
  address: string;
  issuedAt: number;
  expiresAt: number;
  /**
   * The origin the session was minted for.
   *
   * A session without an audience is valid wherever the secret is, so a token
   * minted against a staging deployment would authenticate against production
   * if they shared a secret. Binding it to the origin means a token is only
   * good for the place it was issued for.
   */
  aud: string;
};

type Challenge = {
  nonce: string;
  message: string;
  /** the address the challenge was issued for */
  address: string;
  issuedAt: number;
  expiresAt: number;
  signature?: string;
  sessionToken?: string;
};

/**
 * Process memory, keyed on globalThis so a dev-server hot reload does not empty the
 * store mid-flow. A single-instance deployment is the documented shape — the contract
 * of this module is "one process owns the challenges", which a real deployment would
 * move to Redis without changing a route.
 */
const STATE_KEY = "__crucible_auth_nonces__";
const globalScope = globalThis as unknown as Record<string, unknown>;
const state: { entries: Map<string, Challenge> } =
  (globalScope[STATE_KEY] as { entries: Map<string, Challenge> } | undefined) ?? {
    entries: new Map<string, Challenge>(),
  };
globalScope[STATE_KEY] = state;

function prune(now: number): void {
  for (const [key, record] of state.entries) {
    const ttl = record.signature ? CONSUMED_TTL_MS : CHALLENGE_TTL_MS;
    if (record.issuedAt + ttl <= now) state.entries.delete(key);
  }
  if (state.entries.size > MAX_ENTRIES) {
    for (const key of state.entries.keys()) {
      if (state.entries.size <= MAX_ENTRIES - 1) break;
      state.entries.delete(key);
    }
  }
}

/**
 * The origin this deployment signs for.
 *
 * **Not** derived from the request. The challenge message says "<host> wants
 * you to sign in with your Ethereum account", and a wallet shows that text
 * verbatim — so if the host comes from a header the caller controls, a third
 * party can ask a victim to sign a message that names the attacker's domain,
 * and the victim has no way to tell it apart from the real thing. The server
 * then verifies that signature against the message it stored and issues the
 * victim's session to whoever asked.
 *
 * The stored-message property does not save this: it stops the client from
 * altering the message, not the server from being induced to issue the wrong
 * one.
 *
 * So the origin is configuration. `AUTH_ORIGIN` names it. In production it is
 * required: a deployment that has not been told which origin it is does not
 * sign in anybody.
 */
function configuredOrigin(): string | null {
  const configured = process.env.AUTH_ORIGIN?.trim();
  if (configured) {
    try {
      return new URL(configured).origin;
    } catch {
      console.error(`[crucible] AUTH_ORIGIN is not a URL: ${configured}`);
      return null;
    }
  }
  if (process.env.NODE_ENV === "production") return null;
  return "http://localhost:3000";
}

/** The chain the session is for. EIP-4361 requires it in the message. */
function configuredChainId(): string {
  const raw = process.env.CHAIN_ID?.trim();
  if (raw && /^\d+$/.test(raw)) return raw;
  return "31337";
}

/** Deterministic SIWE-flavoured challenge text — stored, never rebuilt. */
export function buildSignInMessage(
  address: string,
  nonce: string,
  origin: string,
  issuedAt: number,
  chainId: string = configuredChainId(),
): string {
  let host: string;
  try {
    host = new URL(origin).host;
  } catch {
    host = "crucible.local";
  }
  return [
    `${host} wants you to sign in with your Ethereum account:`,
    address.toLowerCase(),
    "",
    "Sign in to Crucible. This signature proves control of your address. It is free and never sends a transaction.",
    "",
    `URI: ${origin}`,
    "Version: 1",
    `Chain ID: ${chainId}`,
    `Nonce: ${nonce}`,
    `Issued At: ${new Date(issuedAt).toISOString()}`,
  ].join("\n");
}

/**
 * Issues a challenge, bound to a browser session.
 *
 * The challenge is stored under a random id that is handed back as an
 * HttpOnly cookie, and the id is the ONLY way to find the challenge again. The
 * nonce is therefore usable only by the browser that asked for it.
 *
 * This is the OAuth "state" parameter in a wallet-shaped form. Without it, a
 * challenge is a bearer token: anyone who learns a nonce — by asking for one
 * for an address, or by watching a victim's request — can complete it from a
 * different browser, and the session it mints lands there.
 */
export function issueChallenge(address: string, origin: string): {
  challengeId: string;
  nonce: string;
  message: string;
  expiresAt: number;
  replayed: boolean;
} {
  const now = Date.now();
  prune(now);
  const challengeId = randomBytes(16).toString("hex");
  const nonce = randomBytes(16).toString("hex");
  const record: Challenge = {
    nonce,
    message: buildSignInMessage(address, nonce, origin, now),
    address: address.toLowerCase(),
    issuedAt: now,
    expiresAt: now + CHALLENGE_TTL_MS,
  };
  state.entries.set(challengeId, record);
  return {
    challengeId,
    nonce: record.nonce,
    message: record.message,
    expiresAt: record.expiresAt,
    replayed: false,
  };
}

/** Returns the live challenge for a session (consumed ones included, for replay). */
function peekChallenge(challengeId: string): Challenge | null {
  const record = state.entries.get(challengeId);
  if (!record) return null;
  const ttl = record.signature ? CONSUMED_TTL_MS : CHALLENGE_TTL_MS;
  if (record.issuedAt + ttl <= Date.now()) return null;
  return record;
}

function markConsumed(challengeId: string, nonce: string, signature: string): void {
  const record = state.entries.get(challengeId);
  if (record && record.nonce === nonce && !record.signature) {
    record.signature = signature;
    record.expiresAt = Date.now() + CONSUMED_TTL_MS;
  }
}

function rememberSessionToken(challengeId: string, nonce: string, sessionToken: string): void {
  const record = state.entries.get(challengeId);
  if (record && record.nonce === nonce) record.sessionToken = sessionToken;
}

/**
 * The session secret, or null when there is none.
 *
 * A missing `AUTH_SECRET` used to be answered differently depending on
 * `NODE_ENV`: a production process refused, and anything else silently signed
 * with a published constant. So a deployment that forgot the variable — a
 * systemd unit, a bare `node dist/server.js`, anything that is not the Docker
 * image — signed sessions with a key in the repository, and anyone could mint a
 * session for any address.
 *
 * The dev secret now has to be asked for by name. Failing closed is the
 * default; the local demo opts in.
 */
function secret(): string | null {
  const fromEnv = process.env.AUTH_SECRET;
  if (fromEnv && fromEnv.length >= 16) return fromEnv;
  if (process.env.AUTH_ALLOW_DEV_SECRET === "1") return DEV_SECRET;
  return null;
}

function signature(encodedPayload: string, key: string): string {
  return createHmac("sha256", key).update(encodedPayload).digest("base64url");
}

export function createSessionToken(
  address: string,
  key: string,
  audience: string = "local",
): { token: string; payload: SessionPayload } {
  const nowSeconds = Math.floor(Date.now() / 1000);
  const payload: SessionPayload = {
    address: address.toLowerCase(),
    issuedAt: nowSeconds,
    expiresAt: nowSeconds + SESSION_TTL_SECONDS,
    aud: audience,
  };
  const encoded = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return { token: `${encoded}.${signature(encoded, key)}`, payload };
}

export function verifySessionToken(
  token: string | undefined | null,
  key: string,
  audience?: string,
): SessionPayload | null {
  if (!token) return null;
  const [encoded, provided] = token.split(".");
  if (!encoded || !provided) return null;
  const expected = signature(encoded, key);
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  try {
    const payload = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8")) as SessionPayload;
    if (!ADDRESS_RE.test(payload.address ?? "")) return null;
    if (typeof payload.expiresAt !== "number" || payload.expiresAt * 1000 < Date.now()) return null;
    // An issued-at in the future is not a token this server made.
    if (typeof payload.issuedAt !== "number" || payload.issuedAt * 1000 > Date.now() + 60_000) return null;
    // A session is only good for the origin it was minted for.
    if (audience !== undefined && payload.aud !== audience) return null;
    return payload;
  } catch {
    return null;
  }
}

function sessionCookie(token: string): string {
  const parts = [
    `${COOKIE_NAME}=${token}`,
    "HttpOnly",
    "SameSite=Lax",
    "Path=/",
    `Max-Age=${SESSION_TTL_SECONDS}`,
  ];
  if (process.env.NODE_ENV === "production") parts.push("Secure");
  return parts.join("; ");
}

function clearedCookie(): string {
  const parts = [`${COOKIE_NAME}=`, "HttpOnly", "SameSite=Lax", "Path=/", "Max-Age=0"];
  // The same attributes the cookie was set with, so a browser matches it and
  // actually deletes it.
  if (process.env.NODE_ENV === "production") parts.push("Secure");
  return parts.join("; ");
}

function cookieOf(c: Context, name: string): string | null {
  const header = c.req.header("cookie");
  if (!header) return null;
  for (const part of header.split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (k === name) return v.join("=");
  }
  return null;
}

/**
 * The cookie that carries the challenge id.
 *
 * It is HttpOnly and short-lived: it names the challenge, and the challenge is
 * the thing that must not be completed from a different browser.
 */
const CHALLENGE_COOKIE = "crucible_challenge";

function challengeCookie(challengeId: string): string {
  const parts = [
    `${CHALLENGE_COOKIE}=${challengeId}`,
    "HttpOnly",
    "SameSite=Lax",
    "Path=/auth",
    `Max-Age=${Math.floor(CHALLENGE_TTL_MS / 1000)}`,
  ];
  if (process.env.NODE_ENV === "production") parts.push("Secure");
  return parts.join("; ");
}

/**
 * The signers a signature could belong to.
 *
 * Two forms are accepted, and both have to recover the claimed address:
 *
 *   * **EIP-4361.** The message is hashed with keccak256 and signed with
 *     secp256k1 with NO EIP-191 prefix. This is what a compliant SIWE client
 *     (the `siwe` library, wagmi's SIWE flow) does, and the previous
 *     implementation rejected every one of them.
 *   * **EIP-191 personal_sign.** What a wallet's "Sign message" button
 *     produces, and what the ported SE-2 flow used.
 *
 * Accepting both costs nothing: a signature still has to recover the claimed
 * address, so a forged one is rejected either way.
 */
async function signersOf(message: string, signature: `0x${string}`): Promise<string[]> {
  const found: string[] = [];
  try {
    found.push(await recoverAddress({ hash: keccak256(toBytes(message)), signature }));
  } catch {
    // Not the EIP-4361 form; the other one may still match.
  }
  try {
    found.push(await recoverMessageAddress({ message, signature }));
  } catch {
    // Not decodable at all.
  }
  return found;
}

/**
 * The four routes, mounted under `/auth` by `app.ts`.
 *
 * They hold no chain keys and cannot move money — the same boundary the rest of the
 * API keeps. A session proves control of an address and nothing else.
 */
export function authRoutes(): Hono {
  const app = new Hono();

  app.post("/nonce", async (c) => {
    const key = secret();
    if (!key) return c.json({ error: "auth_unconfigured", message: "AUTH_SECRET is not configured." }, 503);
    const origin = configuredOrigin();
    if (!origin) {
      return c.json(
        { error: "auth_unconfigured", message: "AUTH_ORIGIN is not configured, so the server cannot say which site it is." },
        503,
      );
    }
    let body: { address?: unknown } | null;
    try {
      body = (await c.req.json()) as { address?: unknown } | null;
    } catch {
      return c.json({ error: "invalid_body", message: "A JSON body is required." }, 400);
    }
    if (!body || typeof body !== "object") {
      return c.json({ error: "invalid_body", message: "A JSON body is required." }, 400);
    }
    const address = typeof body.address === "string" ? body.address : "";
    if (!ADDRESS_RE.test(address)) return c.json({ error: "invalid_address" }, 400);
    const challenge = issueChallenge(address, origin);
    // The challenge id goes back as an HttpOnly cookie, not in the body: the
    // client has no business choosing which challenge it completes.
    c.header("Set-Cookie", challengeCookie(challenge.challengeId));
    return c.json({
      nonce: challenge.nonce,
      message: challenge.message,
      expiresAt: challenge.expiresAt,
      replayed: challenge.replayed,
    });
  });

  app.post("/verify", async (c) => {
    const key = secret();
    if (!key) return c.json({ error: "auth_unconfigured", message: "AUTH_SECRET is not configured." }, 503);
    const origin = configuredOrigin();
    if (!origin) {
      return c.json(
        { error: "auth_unconfigured", message: "AUTH_ORIGIN is not configured, so the server cannot say which site it is." },
        503,
      );
    }

    let body: { address?: unknown; nonce?: unknown; signature?: unknown } | null;
    try {
      body = (await c.req.json()) as { address?: unknown; nonce?: unknown; signature?: unknown } | null;
    } catch {
      return c.json({ error: "invalid_body", message: "A JSON body is required." }, 400);
    }
    if (!body || typeof body !== "object") {
      return c.json({ error: "invalid_body", message: "A JSON body is required." }, 400);
    }

    const address = typeof body.address === "string" ? body.address : "";
    const nonce = typeof body.nonce === "string" ? body.nonce : "";
    const sig = typeof body.signature === "string" ? body.signature : "";

    if (!ADDRESS_RE.test(address)) return c.json({ error: "invalid_address" }, 400);
    if (!nonce || nonce.length > 64) return c.json({ error: "invalid_nonce" }, 400);
    if (!HEX_RE.test(sig) || sig.length < 130) return c.json({ error: "invalid_signature" }, 400);

    // The challenge is found by the id in the caller's cookie, not by the
    // address it was issued for. A challenge is a bearer token otherwise:
    // anyone who learns a nonce could complete it from a different browser,
    // and the session it mints would land there.
    const challengeId = cookieOf(c, CHALLENGE_COOKIE);
    const challenge = challengeId ? peekChallenge(challengeId) : null;
    if (!challenge) {
      return c.json({ error: "challenge_expired", message: "Request a new nonce and sign again." }, 401);
    }
    // And the challenge has to be the one for the address being claimed.
    if (challenge.address !== address.toLowerCase()) {
      return c.json({ error: "address_mismatch", message: "That challenge was issued for another address." }, 401);
    }

    // Exact replay of a consumed challenge → hand back the original session.
    if (challenge.signature) {
      const isReplay = challenge.nonce === nonce && challenge.signature.toLowerCase() === sig.toLowerCase();
      if (!isReplay) {
        return c.json({ error: "challenge_used", message: "This nonce was already used." }, 401);
      }
      if (challenge.sessionToken && verifySessionToken(challenge.sessionToken, key, origin)) {
        const payload = verifySessionToken(challenge.sessionToken, key, origin)!;
        c.header("Set-Cookie", sessionCookie(challenge.sessionToken));
        return c.json({ address: payload.address, session: { expiresAt: payload.expiresAt }, replayed: true });
      }
      // The original session has expired. Minting a fresh seven-day one here
      // would turn a captured `{address, nonce, signature}` tuple into a
      // long-lived credential for as long as the replay window lasts.
      return c.json({ error: "session_expired", message: "Sign in again." }, 401);
    }

    if (challenge.nonce !== nonce) {
      return c.json({ error: "nonce_mismatch", message: "Nonce does not match the active challenge." }, 401);
    }

    const signers = await signersOf(challenge.message, sig as `0x${string}`);
    if (!signers.some((s) => s.toLowerCase() === address.toLowerCase())) {
      return c.json({ error: "bad_signature", message: "Signature does not match the address." }, 401);
    }

    markConsumed(challengeId!, nonce, sig);
    const minted = createSessionToken(address, key, origin);
    c.header("Set-Cookie", sessionCookie(minted.token));
    rememberSessionToken(challengeId!, nonce, minted.token);

    return c.json({
      address: minted.payload.address,
      session: { expiresAt: minted.payload.expiresAt },
      replayed: false,
    });
  });

  app.get("/session", (c) => {
    const key = secret();
    if (!key) return c.json({ error: "auth_unconfigured" }, 503);
    const origin = configuredOrigin();
    if (!origin) return c.json({ error: "auth_unconfigured" }, 503);
    const payload = verifySessionToken(cookieOf(c, COOKIE_NAME), key, origin);
    if (!payload) return c.json({ address: null });
    return c.json({ address: payload.address, session: { expiresAt: payload.expiresAt } });
  });

  app.post("/logout", (c) => {
    c.header("Set-Cookie", clearedCookie());
    return c.json({ ok: true });
  });

  return app;
}
