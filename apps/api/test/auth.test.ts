import { describe, expect, it } from "vitest";
import { privateKeyToAccount } from "viem/accounts";
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
 */

const model = { trials: new Map(), agents: new Map(), byOperator: new Map(), byAgent: new Map(), hall: [] };
const app = createApp({ getModel: () => model as never }, { rateLimit: false });

const account = privateKeyToAccount("0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d");
const ADDRESS = account.address;

async function issueNonce(address: string) {
  const res = await app.request("/auth/nonce", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ address }),
  });
  expect(res.status).toBe(200);
  return (await res.json()) as { nonce: string; message: string; expiresAt: number; replayed: boolean };
}

describe("auth: nonce issuance", () => {
  it("issues a challenge with the stored message the wallet must sign", async () => {
    const { nonce, message } = await issueNonce(ADDRESS);
    expect(nonce).toMatch(/^[0-9a-f]{32}$/);
    expect(message).toContain("wants you to sign in with your Ethereum account:");
    expect(message).toContain(ADDRESS.toLowerCase());
    expect(message).toContain(`Nonce: ${nonce}`);
  });

  it("re-issues the SAME pending challenge for the same address (retries cannot spam the store)", async () => {
    const first = await issueNonce(ADDRESS);
    const second = await issueNonce(ADDRESS);
    expect(second.replayed).toBe(true);
    expect(second.nonce).toBe(first.nonce);
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

describe("auth: verify", () => {
  it("sets a session cookie when the signature matches the stored challenge", async () => {
    const { message } = await issueNonce(ADDRESS);
    const signature = await account.signMessage({ message });

    const res = await app.request("/auth/verify", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ address: ADDRESS, nonce: message.match(/Nonce: (\w+)/)![1], signature }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { address: string; replayed: boolean };
    expect(body.address).toBe(ADDRESS.toLowerCase());
    expect(body.replayed).toBe(false);
    expect(res.headers.get("Set-Cookie")).toContain("crucible_session=");
  });

  it("rejects a signature over different bytes than the server issued", async () => {
    await issueNonce(ADDRESS);
    const signature = await account.signMessage({ message: "sign in to something else entirely" });
    const res = await app.request("/auth/verify", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ address: ADDRESS, nonce: "not-the-issued-nonce", signature }),
    });
    expect(res.status).toBe(401);
  });

  it("replays the exact same verify and returns the byte-identical cookie", async () => {
    const { message, nonce } = await issueNonce(ADDRESS);
    const signature = await account.signMessage({ message });

    const first = await app.request("/auth/verify", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ address: ADDRESS, nonce, signature }),
    });
    const second = await app.request("/auth/verify", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ address: ADDRESS, nonce, signature }),
    });
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    const a = first.headers.get("Set-Cookie")!.split(";")[0];
    const b = second.headers.get("Set-Cookie")!.split(";")[0];
    expect(b).toBe(a);
    expect((await second.json()).replayed).toBe(true);
  });
});

describe("auth: session lifecycle", () => {
  it("reads the address back from the cookie and clears it on logout", async () => {
    const { message, nonce } = await issueNonce(ADDRESS);
    const signature = await account.signMessage({ message });
    const verified = await app.request("/auth/verify", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ address: ADDRESS, nonce, signature }),
    });
    const cookie = verified.headers.get("Set-Cookie")!.split(";")[0];

    const session = await app.request("/auth/session", { headers: { cookie } });
    expect((await session.json()).address).toBe(ADDRESS.toLowerCase());

    const anon = await app.request("/auth/session");
    expect((await anon.json()).address).toBeNull();

    const logout = await app.request("/auth/logout", { method: "POST" });
    expect(logout.status).toBe(200);
    expect(logout.headers.get("Set-Cookie")).toContain("Max-Age=0");
  });
});
