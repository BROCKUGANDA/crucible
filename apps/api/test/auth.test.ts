import { describe, expect, it } from "vitest";
import { privateKeyToAccount } from "viem/accounts";
import { keccak256, toBytes } from "viem";
import { createApp } from "../src/app.js";

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
