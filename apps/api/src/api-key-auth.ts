/**
 * @file api-key-auth.ts — the API key as a CREDENTIAL.
 *
 * An organisation's API key is a read-only credential: it may read the
 * things that belong to its own organisation, and it may not write
 * anything. Writes need a wallet-signed SIWE session (ADR-0006), because a
 * key that could write would be a key that could move money.
 *
 * The presentation is `Authorization: Bearer crux.<secret>`. The `crux.`
 * marker is there so the value is greppable and cannot be confused with
 * another bearer token a client might send. The lookup prefix is the
 * first eight characters of the secret — derived, never carried
 * separately, so the two can never disagree.
 *
 * The secret is verified with the SLOW hash (scrypt, ADR-0040), so every
 * verification costs ~80 ms. That is the right price for a credential
 * check, and it is also why the verification happens once per request and
 * never on a route that does not need a credential.
 */

import type { Context } from "hono";
import { validateApiKey, type OrgApiKey } from "@crucible/agent-security";

/** The marker in front of the secret, so the value is not ambiguous. */
export const API_KEY_BEARER_MARKER = "crux.";

/** The scope an organisation's key must hold to read its organisation. */
export const ORG_READ_SCOPE = "org:read";

export interface ApiKeyPrincipal {
  kind: "api-key";
  keyId: string;
  /** the organisation the key acts for */
  orgId: string;
  scopes: readonly string[];
  /** the key itself, for the routes that need its name */
  key: OrgApiKey;
}

/**
 * The presentation, if the request carries one.
 *
 * A request with no `Authorization` header carries no presentation — it is
 * not an invalid credential, it is an absent one, and the caller decides
 * what to do about that.
 */
export function presentedApiKey(c: Context): { secret: string } | null {
  const header = c.req.header("authorization") ?? c.req.header("Authorization");
  if (!header) return null;
  const match = /^Bearer\s+crux\.(.+)$/i.exec(header.trim());
  if (!match || !match[1]) return null;
  return { secret: match[1] };
}

/**
 * Verify the presented key and check that it may do what is asked.
 *
 * Returns the principal, or a refusal with the reason. The reason is
 * specific on purpose: "your key was revoked" and "your key does not
 * have the org:read scope" are different facts and a caller that cannot
 * tell them apart cannot act.
 */
export async function verifiedApiKey(
  c: Context,
  requiredScopes: readonly string[],
): Promise<
  | { ok: true; principal: ApiKeyPrincipal }
  | { ok: false; code: string; reason: string; status: number }
> {
  const presented = presentedApiKey(c);
  if (!presented) {
    return {
      ok: false,
      code: "no-credential",
      reason: "no API key was presented",
      status: 401,
    };
  }
  if (presented.secret.length < 16) {
    // Too short to be a key this platform minted: refuse it without
    // hashing it, because a slow hash on a value that cannot be valid is
    // a gift to whoever is sending them.
    return {
      ok: false,
      code: "no-credential",
      reason: "the API key presentation is malformed",
      status: 401,
    };
  }

  const prefix = presented.secret.slice(0, 8);
  const result = await validateApiKey(prefix, presented.secret, requiredScopes);
  if (!result.valid || !result.key) {
    const code = result.code ?? "no-credential";
    const status = code === "wrong-scope" ? 403 : 401;
    const reason =
      code === "revoked"
        ? "this API key was revoked"
        : code === "expired"
          ? "this API key has expired"
          : code === "wrong-scope"
            ? `this API key does not carry the ${requiredScopes.join(", ")} scope`
            : "this API key is not valid";
    return { ok: false, code, reason, status };
  }

  return {
    ok: true,
    principal: {
      kind: "api-key",
      keyId: result.key.id,
      orgId: result.key.orgId,
      scopes: result.key.scopes,
      key: result.key,
    },
  };
}
