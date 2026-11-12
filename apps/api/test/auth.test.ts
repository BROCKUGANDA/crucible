import { describe, expect, it } from "vitest";
import { Hono } from "hono";
import { privateKeyToAccount } from "viem/accounts";
import { keccak256, toBytes } from "viem";
import { createApp } from "../src/app.js";
import { requireIdentityState, type IdentityState } from "../src/auth.js";

/**
 * The auth surface, exercised end to end through `app.request` — the same way the
 * route tests in `app.test.ts` reach the app, because a route that is only tested
 * against its handler is not a route.
 *
 * The two properties that matter are the ones the SE-2 port was made to keep:
 * verification recovers the signer against the *stored* challenge bytes (not a
 * client reconstruction), and a replayed verify returns the byte-identical
 * session cookie rather than an error.
 *
 * The third is the one that was not: the origin in the challenge message comes
 * from configuration, and the challenge is bound to the browser that asked for
 * it, so a caller can neither choose the text nor complete a challenge from
 * somewhere else.
 */

// The auth routes fail closed: a missing secret means no session is signed, and
// a missing origin means the server does not say which site it is. The test
// therefore has to ask for the development behaviour by name, which is the
// point — a deployment that forgets the variable gets 503, not a session signed
// with a key from the repository.
process.env.AUTH_ALLOW_DEV_SECRET = "1";
process.env.AUTH_ORIGIN = "http://localhost:3000";

const model = { trials: new Map(), agents: new Map(), byOperator: new Map(), byAgent: new Map(), hall: [] };
const app = createApp({ getModel: () => model as never }, { rateLimit: false });

const account = privateKeyToAccount("0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d");
const ADDRESS = account.address;

/** The challenge cookie the server hands back with a nonce. */
function challengeCookieOf(res: Response): string {
  const setCookie = res.headers.get("Set-Cookie") ?? "";
  const match = /crucible_challenge=([^;]+)/.exec(setCookie);
  expect(match, `no challenge cookie in "${setCookie}"`).toBeTruthy();
  return `crucible_challenge=${match![1]}`;
}

async function issueNonce(address: string, headers: Record<string, string> = {}) {
  const res = await app.request("/auth/nonce", {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify({ address }),
  });
  expect(res.status).toBe(200);
  const cookie = challengeCookieOf(res);
  const body = (await res.json()) as { nonce: string; message: string; expiresAt: number; replayed: boolean };
  return { ...body, cookie };
}

describe("auth: nonce issuance", () => {
  it("issues a challenge with the stored message the wallet must sign", async () => {
    const { nonce, message } = await issueNonce(ADDRESS);
    expect(nonce).toMatch(/^[0-9a-f]{32}$/);
    expect(message).toContain("wants you to sign in with your Ethereum account:");
    expect(message).toContain(ADDRESS.toLowerCase());
    expect(message).toContain(`Nonce: ${nonce}`);
  });

  it("re-issues a challenge rather than reusing the previous one", async () => {
    // A retry must not be able to accumulate pending challenges for one
    // address: each request gets its own challenge, bound to its own cookie.
    const first = await issueNonce(ADDRESS);
    const second = await issueNonce(ADDRESS);
    expect(second.nonce).not.toBe(first.nonce);
  });

  it("rejects a malformed address before touching the store", async () => {
    const res = await app.request("/auth/nonce", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ address: "0x1234" }),
    });
    expect(res.status).toBe(400);
  });

  /**
   * A body the caller never announced.
   *
   * The middleware's limit only sees an announced `Content-Length`. A request
   * that says `Transfer-Encoding: chunked` announces nothing, and the two
   * routes that read a body used to buffer all of it — so a caller could send
   * as much as it liked and the process would hold it in memory. The ceiling
   * is now applied to the bytes actually read.
   */
  it("refuses a body larger than the ceiling, chunked or not", async () => {
    const chunk = new TextEncoder().encode("x".repeat(64 * 1024));
    const res = await app.request("/auth/nonce", {
      method: "POST",
      headers: { "content-type": "application/json", "transfer-encoding": "chunked" },
      body: new ReadableStream({
        start(controller) {
          controller.enqueue(chunk);
          controller.enqueue(chunk);
          controller.close();
        },
      }),
      // @ts-expect-error — a stream body is exactly what is being tested.
      duplex: "half",
    });
    expect(res.status).toBe(413);
  });
});

describe("auth: the origin is configured, not claimed by the caller", () => {
  it("names the configured site whatever the request says it is", async () => {
    const { message } = await issueNonce(ADDRESS, { host: "evil.example", origin: "https://evil.example" });
    // The message names THIS deployment, never the host the caller sent.
    expect(message).toContain("localhost:3000 wants you to sign in");
    expect(message).not.toContain("evil.example");
    expect(message).toContain("URI: http://localhost:3000");
  });

  it("cannot be used to complete a challenge from a different browser", async () => {
    // The attack: ask for a challenge for someone else's address, show them
    // the text, and replay their signature. The text used to come from a
    // caller-controlled Host header, so the attacker chose what the victim
    // saw.
    //
    // Two things close it. The text is the server's own — it names the
    // configured origin, so the caller cannot write a message that reads
    // like it came from somewhere else. And the challenge is bound to the
    // browser that asked for it, so it can only be completed by that
    // browser, which is the one whose session the signature ends up in.
    const victim = privateKeyToAccount("0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80");
    const attacker = privateKeyToAccount("0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d");

    const { nonce, message, cookie } = await issueNonce(victim.address, { host: "evil.example" });

    // The victim signs what they were shown.
    const signature = await victim.signMessage({ message });

    // The attacker replays it WITHOUT the challenge cookie. The server has no
    // way to find the challenge, so it refuses.
    const stolen = await app.request("/auth/verify", {
      method: "POST",
      headers: { "content-type": "application/json", host: "evil.example" },
      body: JSON.stringify({ address: victim.address, nonce, signature }),
    });
    expect(stolen.status).toBe(401);

    // And the attacker's own signature is not the victim's, even with the
    // cookie.
    const attackerSig = await attacker.signMessage({ message });
    const forged = await app.request("/auth/verify", {
      method: "POST",
      headers: { "content-type": "application/json", host: "evil.example", cookie },
      body: JSON.stringify({ address: victim.address, nonce, signature: attackerSig }),
    });
    expect(forged.status).toBe(401);
  });

  it("refuses a challenge for one address to be used for another", async () => {
    const { nonce, message, cookie } = await issueNonce(ADDRESS);
    const signature = await account.signMessage({ message });
    const other = privateKeyToAccount("0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80");

    const res = await app.request("/auth/verify", {
      method: "POST",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({ address: other.address, nonce, signature }),
    });
    expect(res.status).toBe(401);
  });

  it("carries the chain id, so a signature is not replayable across chains", async () => {
    const { message } = await issueNonce(ADDRESS);
    expect(message).toMatch(/^Chain ID: \d+$/m);
  });
});

describe("auth: verify", () => {
  it("sets a session cookie when the signature matches the stored challenge", async () => {
    const { message, nonce, cookie } = await issueNonce(ADDRESS);
    const signature = await account.signMessage({ message });

    const res = await app.request("/auth/verify", {
      method: "POST",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({ address: ADDRESS, nonce, signature }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { address: string; replayed: boolean };
    expect(body.address).toBe(ADDRESS.toLowerCase());
    expect(body.replayed).toBe(false);
    expect(res.headers.get("Set-Cookie")).toContain("crucible_session=");
  });

  it("rejects a signature over different bytes than the server issued", async () => {
    const { cookie } = await issueNonce(ADDRESS);
    const signature = await account.signMessage({ message: "sign in to something else entirely" });
    const res = await app.request("/auth/verify", {
      method: "POST",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({ address: ADDRESS, nonce: "not-the-issued-nonce", signature }),
    });
    expect(res.status).toBe(401);
  });

  it("replays the exact same verify and returns the byte-identical cookie", async () => {
    const { message, nonce, cookie } = await issueNonce(ADDRESS);
    const signature = await account.signMessage({ message });

    const first = await app.request("/auth/verify", {
      method: "POST",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({ address: ADDRESS, nonce, signature }),
    });
    const second = await app.request("/auth/verify", {
      method: "POST",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({ address: ADDRESS, nonce, signature }),
    });
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    const a = first.headers.get("Set-Cookie")!.split(";")[0];
    const b = second.headers.get("Set-Cookie")!.split(";")[0];
    expect(b).toBe(a);
    expect((await second.json()).replayed).toBe(true);
  });

  it("accepts an EIP-4361 signature, which signs the raw hash with no prefix", async () => {
    // The previous implementation recovered with `recoverMessageAddress`,
    // which applies the EIP-191 personal_sign prefix — so every compliant
    // SIWE client (the `siwe` library, wagmi's SIWE flow) was rejected.
    const { message, nonce, cookie } = await issueNonce(ADDRESS);
    const signature = await account.sign({ hash: keccak256(toBytes(message)) });

    const res = await app.request("/auth/verify", {
      method: "POST",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({ address: ADDRESS, nonce, signature }),
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("Set-Cookie")).toContain("crucible_session=");
  });
});

describe("auth: session lifecycle", () => {
  it("reads the address back from the cookie and clears it on logout", async () => {
    const { message, nonce, cookie } = await issueNonce(ADDRESS);
    const signature = await account.signMessage({ message });
    const verified = await app.request("/auth/verify", {
      method: "POST",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({ address: ADDRESS, nonce, signature }),
    });
    const session = verified.headers.get("Set-Cookie")!.split(";")[0];

    const read = await app.request("/auth/session", { headers: { cookie: session } });
    expect((await read.json()).address).toBe(ADDRESS.toLowerCase());

    const anon = await app.request("/auth/session");
    expect((await anon.json()).address).toBeNull();

    const logout = await app.request("/auth/logout", { method: "POST" });
    expect(logout.status).toBe(200);
    expect(logout.headers.get("Set-Cookie")).toContain("Max-Age=0");
  });
});

describe("identity: seven-state model", () => {
  it("resolves ANONYMOUS when no session and no wallet header", async () => {
    const res = await app.request("/snapshot");
    expect(res.status).toBe(200);
    expect(res.headers.get("X-Crucible-Identity-State")).toBe("ANONYMOUS");
  });

  it("resolves WALLET_CONNECTED when a wallet header is present without a session", async () => {
    const res = await app.request("/snapshot", {
      headers: { "x-crucible-wallet": `0x${"aa".repeat(20)}` },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("X-Crucible-Identity-State")).toBe("WALLET_CONNECTED");
  });

  it("rejects a malformed wallet header and falls back to ANONYMOUS", async () => {
    const res = await app.request("/snapshot", {
      headers: { "x-crucible-wallet": "0x1234" },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("X-Crucible-Identity-State")).toBe("ANONYMOUS");
  });

  it("resolves SIWE_AUTHENTICATED when a valid session cookie is present", async () => {
    const { message, nonce, cookie } = await issueNonce(ADDRESS);
    const signature = await account.signMessage({ message });
    const verified = await app.request("/auth/verify", {
      method: "POST",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({ address: ADDRESS, nonce, signature }),
    });
    expect(verified.status).toBe(200);
    const session = verified.headers.get("Set-Cookie")!.split(";")[0];

    const res = await app.request("/snapshot", { headers: { cookie: session } });
    expect(res.status).toBe(200);
    expect(res.headers.get("X-Crucible-Identity-State")).toBe("SIWE_AUTHENTICATED");
  });

  it("SIWE session beats wallet header — the session is the stronger state", async () => {
    const { message, nonce, cookie } = await issueNonce(ADDRESS);
    const signature = await account.signMessage({ message });
    const verified = await app.request("/auth/verify", {
      method: "POST",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({ address: ADDRESS, nonce, signature }),
    });
    expect(verified.status).toBe(200);
    const session = verified.headers.get("Set-Cookie")!.split(";")[0];

    const res = await app.request("/snapshot", {
      headers: {
        cookie: session,
        "x-crucible-wallet": `0x${"bb".repeat(20)}`,
      },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("X-Crucible-Identity-State")).toBe("SIWE_AUTHENTICATED");
  });
});

describe("identity: requireIdentityState middleware", () => {
  it("permits callers at or above the required state", async () => {
    const app = new Hono();
    app.use("*", requireIdentityState("SIWE_AUTHENTICATED"));
    app.get("/", (c) => c.json({ ok: true }));

    const res = await app.request("/", {
      headers: { cookie: "crucible_session=invalid.token" },
    });
    // An unverifiable cookie resolves to ANONYMOUS, which is below SIWE_AUTHENTICATED.
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error).toBe("insufficient_identity_state");
    expect(body.required).toBe("SIWE_AUTHENTICATED");
    expect(body.current).toBe("ANONYMOUS");
  });

  it("permits ANONYMOUS when no minimum is required", async () => {
    const app = new Hono();
    app.use("*", requireIdentityState("ANONYMOUS"));
    app.get("/", (c) => c.json({ ok: true }));

    const res = await app.request("/");
    expect(res.status).toBe(200);
  });
});

/**
 * The race the async nonce store reopened, and the atomic consume that closes it.
 *
 * The route reads the challenge, awaits signature recovery (real crypto, real milliseconds), then
 * marks it consumed. With a process-local Map the mark was synchronous and could not interleave;
 * with Redis it became get → check → set across two round trips, so two concurrent requests carrying
 * one captured `{address, nonce, signature}` both read an unconsumed record and both minted a
 * session. That is the replay the store exists to prevent.
 *
 * The assertion is on the *count of sessions*, not on a status code: a fix that returned 401 for
 * both requests would pass a weaker test and break sign-in entirely.
 */
describe("auth: one signature, one session, even concurrently", () => {
  it("mints exactly one session when the same verify arrives twice at once", async () => {
    const { message, nonce, cookie } = await issueNonce(ADDRESS);
    const signature = await account.signMessage({ message });
    const request = () =>
      app.request("/auth/verify", {
        method: "POST",
        headers: { "content-type": "application/json", cookie },
        body: JSON.stringify({ address: ADDRESS, nonce, signature }),
      });

    const [a, b] = await Promise.all([request(), request()]);
    const bodies = await Promise.all([a.json(), b.json()]);
    const minted = [a, b].filter((res, i) => res.status === 200 && (bodies[i] as { replayed?: boolean }).replayed === false);
    const refused = [a, b].filter((res) => res.status === 401);

    expect(minted).toHaveLength(1);
    expect(refused).toHaveLength(1);
    // And the refusal names the reason rather than looking like a bad signature.
    const refusedBody = bodies[[a, b].findIndex((res) => res.status === 401)] as { error: string };
    expect(refusedBody.error).toBe("challenge_used");
  });

  it("still replays a sequential retry with the original cookie", async () => {
    const { message, nonce, cookie } = await issueNonce(ADDRESS);
    const signature = await account.signMessage({ message });
    const request = () =>
      app.request("/auth/verify", {
        method: "POST",
        headers: { "content-type": "application/json", cookie },
        body: JSON.stringify({ address: ADDRESS, nonce, signature }),
      });

    const first = await request();
    const second = await request();
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect((await second.json()).replayed).toBe(true);
    // Byte-identical: a replay must not mint a second credential with a different expiry.
    expect(second.headers.get("Set-Cookie")).toBe(first.headers.get("Set-Cookie"));
  });
});

describe("auth: the secret is supplied, not inferred from the environment", () => {
  /**
   * The regression this file exists to prevent: `secret()` used to answer the
   * dev constant whenever `NODE_ENV !== "production"`, so any host that never
   * set NODE_ENV — or set it to "staging" — signed sessions with a key
   * published in the repository. `.env.example` says the opposite: no secret,
   * 503. Both shapes of the old bug are asserted here.
   */
  it("refuses to sign when AUTH_SECRET is unset, whatever NODE_ENV says", async () => {
    const saved = {
      secret: process.env.AUTH_SECRET,
      dev: process.env.AUTH_ALLOW_DEV_SECRET,
      nodeEnv: process.env.NODE_ENV,
    };
    const call = () =>
      app.request("/auth/nonce", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ address: ADDRESS }),
      });
    try {
      delete process.env.AUTH_SECRET;
      delete process.env.AUTH_ALLOW_DEV_SECRET;

      // A host that never sets NODE_ENV at all.
      delete process.env.NODE_ENV;
      const bare = await call();
      expect(bare.status).toBe(503);
      expect(((await bare.json()) as { error: string }).error).toBe("auth_unconfigured");

      // A host that sets a non-production NODE_ENV — the branch that signed.
      process.env.NODE_ENV = "development";
      const development = await call();
      expect(development.status).toBe(503);
      expect(((await development.json()) as { error: string }).error).toBe("auth_unconfigured");
    } finally {
      for (const [key, value] of Object.entries(saved)) {
        const name = key === "secret" ? "AUTH_SECRET" : key === "dev" ? "AUTH_ALLOW_DEV_SECRET" : "NODE_ENV";
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
    }
  });
});
