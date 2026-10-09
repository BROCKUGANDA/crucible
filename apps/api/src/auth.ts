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
 * `app.ts`). The session cookie is HMAC'd with `AUTH_SECRET`; with no secret
 * configured the routes answer 503 rather than falling back to a known key, because an
 * auth system that silently signs with a default is worse than one that is off.
 */
import { Hono } from "hono";
import type { Context } from "hono";
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { recoverMessageAddress } from "viem";

const CHALLENGE_TTL_MS = 5 * 60_000;
const CONSUMED_TTL_MS = 10 * 60_000;
const MAX_ENTRIES = 5_000;
const COOKIE_NAME = "crucible_session";
const SESSION_TTL_SECONDS = 60 * 60 * 24 * 7;
const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;
const HEX_RE = /^0x[0-9a-fA-F]+$/;

export type SessionPayload = {
  address: string;
  issuedAt: number;
  expiresAt: number;
};

type Challenge = {
  nonce: string;
  message: string;
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

/** Deterministic SIWE-flavoured challenge text — stored, never rebuilt. */
export function buildSignInMessage(address: string, nonce: string, origin: string, issuedAt: number): string {
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
    `Nonce: ${nonce}`,
    `Issued At: ${new Date(issuedAt).toISOString()}`,
  ].join("\n");
}

export function issueChallenge(address: string, origin: string) {
  const key = address.toLowerCase();
  const now = Date.now();
  prune(now);
  const existing = state.entries.get(key);
  if (existing && !existing.signature && existing.expiresAt > now) {
    return { nonce: existing.nonce, message: existing.message, expiresAt: existing.expiresAt, replayed: true };
  }
  const nonce = randomBytes(16).toString("hex");
  const record: Challenge = {
    nonce,
    message: buildSignInMessage(address, nonce, origin, now),
    issuedAt: now,
    expiresAt: now + CHALLENGE_TTL_MS,
  };
  state.entries.set(key, record);
  return { nonce: record.nonce, message: record.message, expiresAt: record.expiresAt, replayed: false };
}

/** Returns the live challenge for an address (consumed ones included, for replay). */
function peekChallenge(address: string): Challenge | null {
  const record = state.entries.get(address.toLowerCase());
  if (!record) return null;
  const ttl = record.signature ? CONSUMED_TTL_MS : CHALLENGE_TTL_MS;
  if (record.issuedAt + ttl <= Date.now()) return null;
  return record;
}

function markConsumed(address: string, nonce: string, signature: string): void {
  const record = state.entries.get(address.toLowerCase());
  if (record && record.nonce === nonce && !record.signature) {
    record.signature = signature;
    record.expiresAt = Date.now() + CONSUMED_TTL_MS;
  }
}

function rememberSessionToken(address: string, nonce: string, sessionToken: string): void {
  const record = state.entries.get(address.toLowerCase());
  if (record && record.nonce === nonce) record.sessionToken = sessionToken;
}

function secret(): string | null {
  const fromEnv = process.env.AUTH_SECRET;
  if (fromEnv && fromEnv.length >= 16) return fromEnv;
  if (process.env.NODE_ENV === "production") return null; // routes answer 503, never sign with a default
  return "crucible-local-dev-secret-not-for-production";
}

function signature(encodedPayload: string, key: string): string {
  return createHmac("sha256", key).update(encodedPayload).digest("base64url");
}

export function createSessionToken(address: string, key: string): { token: string; payload: SessionPayload } {
  const nowSeconds = Math.floor(Date.now() / 1000);
  const payload: SessionPayload = {
    address: address.toLowerCase(),
    issuedAt: nowSeconds,
    expiresAt: nowSeconds + SESSION_TTL_SECONDS,
  };
  const encoded = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return { token: `${encoded}.${signature(encoded, key)}`, payload };
}

export function verifySessionToken(token: string | undefined | null, key: string): SessionPayload | null {
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
  return `${COOKIE_NAME}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0`;
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
 * The four routes, mounted under `/auth` by `app.ts`.
 *
 * They hold no chain keys and cannot move money — the same boundary the rest of the
 * API keeps. A session proves control of an address and nothing else.
 */
export function authRoutes(): Hono {
  const app = new Hono();

  /** An origin the browser will actually send, used only to make the message honest. */
  const originOf = (c: Context): string => {
    try {
      return new URL(c.req.url).origin;
    } catch {
      return "http://localhost:3000";
    }
  };

  app.post("/nonce", async (c) => {
    const key = secret();
    if (!key) return c.json({ error: "auth_unconfigured", message: "AUTH_SECRET is not configured." }, 503);
    let body: { address?: unknown };
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "invalid_body", message: "A JSON body is required." }, 400);
    }
    const address = typeof body.address === "string" ? body.address : "";
    if (!ADDRESS_RE.test(address)) return c.json({ error: "invalid_address" }, 400);
    return c.json(issueChallenge(address, originOf(c)));
  });

  app.post("/verify", async (c) => {
    const key = secret();
    if (!key) return c.json({ error: "auth_unconfigured", message: "AUTH_SECRET is not configured." }, 503);

    let body: { address?: unknown; nonce?: unknown; signature?: unknown };
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "invalid_body", message: "A JSON body is required." }, 400);
    }

    const address = typeof body.address === "string" ? body.address : "";
    const nonce = typeof body.nonce === "string" ? body.nonce : "";
    const sig = typeof body.signature === "string" ? body.signature : "";

    if (!ADDRESS_RE.test(address)) return c.json({ error: "invalid_address" }, 400);
    if (!nonce || nonce.length > 64) return c.json({ error: "invalid_nonce" }, 400);
    if (!HEX_RE.test(sig) || sig.length < 130) return c.json({ error: "invalid_signature" }, 400);

    const challenge = peekChallenge(address);
    if (!challenge) {
      return c.json({ error: "challenge_expired", message: "Request a new nonce and sign again." }, 401);
    }

    // Exact replay of a consumed challenge → hand back the original session.
    if (challenge.signature) {
      const isReplay = challenge.nonce === nonce && challenge.signature.toLowerCase() === sig.toLowerCase();
      if (!isReplay) {
        return c.json({ error: "challenge_used", message: "This nonce was already used." }, 401);
      }
      if (challenge.sessionToken && verifySessionToken(challenge.sessionToken, key)) {
        c.header("Set-Cookie", sessionCookie(challenge.sessionToken));
        const payload = verifySessionToken(challenge.sessionToken, key)!;
        return c.json({ address: payload.address, session: { expiresAt: payload.expiresAt }, replayed: true });
      }
      const minted = createSessionToken(address, key);
      c.header("Set-Cookie", sessionCookie(minted.token));
      rememberSessionToken(address, nonce, minted.token);
      return c.json({
        address: minted.payload.address,
        session: { expiresAt: minted.payload.expiresAt },
        replayed: true,
      });
    }

    if (challenge.nonce !== nonce) {
      return c.json({ error: "nonce_mismatch", message: "Nonce does not match the active challenge." }, 401);
    }

    let recovered: string;
    try {
      recovered = await recoverMessageAddress({ message: challenge.message, signature: sig as `0x${string}` });
    } catch {
      return c.json({ error: "invalid_signature", message: "Signature could not be decoded." }, 400);
    }
    if (recovered.toLowerCase() !== address.toLowerCase()) {
      return c.json({ error: "bad_signature", message: "Signature does not match the address." }, 401);
    }

    markConsumed(address, nonce, sig);
    const minted = createSessionToken(address, key);
    c.header("Set-Cookie", sessionCookie(minted.token));
    rememberSessionToken(address, nonce, minted.token);

    return c.json({
      address: minted.payload.address,
      session: { expiresAt: minted.payload.expiresAt },
      replayed: false,
    });
  });

  app.get("/session", (c) => {
    const key = secret();
    if (!key) return c.json({ error: "auth_unconfigured" }, 503);
    const payload = verifySessionToken(cookieOf(c, COOKIE_NAME), key);
    if (!payload) return c.json({ address: null });
    return c.json({ address: payload.address, session: { expiresAt: payload.expiresAt } });
  });

  app.post("/logout", (c) => {
    c.header("Set-Cookie", clearedCookie());
    return c.json({ ok: true });
  });

  return app;
}
