// The auth routes fail closed: a missing secret means no session is signed.
process.env.AUTH_ALLOW_DEV_SECRET = "1";
process.env.AUTH_ORIGIN = "http://localhost:3000";

import { afterEach, describe, expect, it } from "vitest";
import { createHmac } from "node:crypto";
import { privateKeyToAccount, type PrivateKeyAccount } from "viem/accounts";
import { createApp } from "../src/app.js";
import {
  createOrganisation,
  createMembership,
  newMembership,
  newOrganisation,
  __resetForgeStoreForTests,
} from "@crucible/agent-security";
import { emptyModel } from "@crucible/indexer";

process.env.AUTH_ALLOW_DEV_SECRET = "1";
process.env.AUTH_ORIGIN = "http://localhost:3000";

const ownerAccount = privateKeyToAccount("0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80");
const OWNER = ownerAccount.address;
const strangerAccount = privateKeyToAccount("0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d");
const STRANGER = strangerAccount.address;
const ORG_ID = "org-test";
const DEV_SECRET = "crucible-local-dev-secret-not-for-production";

const ownerPrincipalId = `eip155:31337:${OWNER.toLowerCase()}`;
const testOrg = newOrganisation(ORG_ID, "Test Org", "test-org", ownerPrincipalId);
createOrganisation(testOrg);

// A hand-signed cookie for the tests that construct deliberately-broken ones.
function handSignedCookie(payload: Record<string, unknown>): Headers {
  const encoded = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const sig = createHmac("sha256", DEV_SECRET).update(encoded).digest("base64url");
  return new Headers({ cookie: `__Host-crucible_session=${encoded}.${sig}` });
}

// Sessions are minted the way the browser mints them: nonce, signature over the
// server's message, verify. A hand-built cookie would test the fixture, not the
// verification the hardening work put in front of these routes.
async function signIn(
  app: ReturnType<typeof createApp>,
  account: PrivateKeyAccount,
): Promise<Headers> {
  const nonceRes = await app.request("/auth/nonce", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ address: account.address }),
  });
  if (nonceRes.status !== 200) throw new Error("nonce failed: " + nonceRes.status);
  const setCookie = nonceRes.headers.get("set-cookie") ?? "";
  const cookie = setCookie.split(";")[0];
  const { nonce, message } = (await nonceRes.json()) as { nonce: string; message: string };
  const signature = await account.signMessage({ message });
  const verify = await app.request("/auth/verify", {
    method: "POST",
    headers: { "content-type": "application/json", cookie },
    body: JSON.stringify({ address: account.address, nonce, signature }),
  });
  if (verify.status !== 200) throw new Error("verify failed: " + verify.status);
  const session = verify.headers.get("set-cookie") ?? "";
  return new Headers({ cookie: session.split(";")[0] });
}
function appWith() {
  return createApp({ getModel: () => emptyModel() }, { rateLimit: false });
}

afterEach(() => {
  __resetForgeStoreForTests();
});

describe("Org routes", () => {
  it("lists organisations for an authenticated member", async () => {
    const app = appWith();
    const res = await app.request("/orgs", { headers: await signIn(app, ownerAccount) });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(Array.isArray(body.organisations)).toBe(true);
    expect(body.organisations.some((o: { id: string }) => o.id === ORG_ID)).toBe(true);
  });

  it("gets an organisation by id for a member", async () => {
    const app = appWith();
    const res = await app.request(`/orgs/${ORG_ID}`, { headers: await signIn(app, ownerAccount) });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.organisation.id).toBe(ORG_ID);
  });

  it("rejects unauthenticated callers", async () => {
    const app = appWith();
    const res = await app.request("/orgs");
    expect(res.status).toBe(401);
  });

  it("rejects a forged session cookie with an invalid HMAC", async () => {
    const headers = await signIn(appWith(), ownerAccount);
    const token = headers.get("cookie")!.replace("__Host-crucible_session=", "");
    const [payload] = token.split(".");
    headers.set("cookie", `__Host-crucible_session=${payload}.${Buffer.alloc(32, 0).toString("base64url")}`);

    const res = await appWith().request("/orgs", { headers });
    expect(res.status).toBe(401);
  });

  it("rejects a session issued for a different audience", async () => {
    const now = Math.floor(Date.now() / 1000);
    const res = await appWith().request("/orgs", {
      headers: handSignedCookie({
        address: OWNER,
        issuedAt: now,
        expiresAt: now + 60 * 60 * 24 * 7,
        aud: "https://attacker.example",
      }),
    });
    expect(res.status).toBe(401);
  });

  it("rejects an expired session", async () => {
    const now = Math.floor(Date.now() / 1000);
    const res = await appWith().request("/orgs", {
      headers: handSignedCookie({
        address: OWNER,
        issuedAt: now - 100,
        expiresAt: now - 1,
        aud: "http://localhost:3000",
      }),
    });
    expect(res.status).toBe(401);
  });

  it("forbids non-members", async () => {
    const app = appWith();
    const res = await app.request(`/orgs/${ORG_ID}`, { headers: await signIn(app, strangerAccount) });
    expect(res.status).toBe(403);
  });

  it("a readonly member cannot create budgets or mint API keys (role matrix, not membership)", async () => {
    const readonlyAccount = privateKeyToAccount(
      "0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a",
    );
    createMembership(
      newMembership(
        `mem-readonly-${ORG_ID}`,
        ORG_ID,
        `eip155:31337:${readonlyAccount.address.toLowerCase()}`,
        "org.readonly.analyst",
        ownerPrincipalId,
      ),
    );

    const app = appWith();
    const headers = await signIn(app, readonlyAccount);

    const budget = await app.request(`/orgs/${ORG_ID}/budgets`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        budgetId: "b-readonly",
        category: "evaluation_spend",
        totalUnits: "100",
        periodStart: 1,
        periodEnd: 2,
      }),
    });
    expect(budget.status).toBe(403);

    const key = await app.request(`/orgs/${ORG_ID}/api-keys`, {
      method: "POST",
      headers,
      body: JSON.stringify({ keyId: "k-readonly", name: "n" }),
    });
    expect(key.status).toBe(403);
  });
});
