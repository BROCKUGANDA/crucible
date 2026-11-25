# ADR-0041 — An API key reads its own organisation, and writes nothing

- **Status**: accepted
- **Date**: 2026-11-20
- **Deciders**: platform engineering
- **Relates to**: ADR-0006 (writes need a wallet signature), ADR-0033 (stores are chosen once at boot), ADR-0040 (the keys are durable, and slow to verify)

## Context

ADR-0040 made the organisation API keys durable and named what was still
missing: **nothing authenticated with them**. `validateApiKey` had no
caller outside its own tests, so the credential existed only on a
spreadsheet, and the commercial promise — "your team polls the API with a
key" — was not yet true.

A key also has to be a *bounded* credential. A key that could do everything
its organisation's owner can do would be a key that could, one permission
change later, move money: the API holds no chain key (ADR-0006), but a
wallet signature is what authorises a withdrawal, and a key that could
convince the platform that a signature existed would be a key that could
withdraw.

## Decision

**An organisation's key is a READ credential, bound to that organisation.**

- The presentation is `Authorization: Bearer crux.<secret>`. The `crux.`
  marker keeps the value greppable and distinguishes it from any other
  bearer token a client might send. The lookup prefix is the first eight
  characters of the secret — **derived**, never carried separately, so the
  two can never disagree.
- The secret is verified with the slow hash (scrypt, ADR-0040): ~80 ms per
  verification, once per request, never on a route that needs no credential.
- The key must carry the scope the request needs. A missing scope is a
  **403** and names the scope (`org:read`); an invalid secret, a revoked
  key and an expired key are **401** with their own reasons. "Your key was
  revoked" and "your key does not carry the scope" are different facts, and
  a caller that cannot tell them apart cannot act.
- **A key reads its own organisation and nothing else.** A key presented for
  another organisation is refused with `key-not-for-this-org` — a key that
  reads another organisation would be a key with the wrong grant, not a key
  with a missing check.
- **A key writes nothing.** The write routes ask for a wallet session and
  nothing else; a key cannot create a credential, revoke a credential or
  invite a member. Writes need a wallet signature (ADR-0006).

The surface is deliberately small: `GET /orgs/:id` and
`GET /orgs/:id/api-keys` — the organisation's own record and its own key
list (prefixes and names, never a hash). The membership list, the
invitations and the budgets are wallet-side governance surfaces and stay
that way for now.

## Consequences

**Good**

- The commercial promise is now half true: an enterprise's automation can
  read its organisation with a key, and the key is revocable, durable and
  slow to guess.
- The credential's blast radius is explicit and small, and it is stated in
  one place rather than implied by which routes happen to check it.

**Bad, and named**

- **The surface is two routes.** "Your team polls the API with a key" is
  true for the organisation record and nothing else; the sponsor's funding
  ledger, the trials, the publications and the disputes are still
  wallet-only. Widening it means adding the scope checks to each route,
  and each one has to name the scope it needs.
- **~80 ms per verification on a public endpoint** is a denial-of-service
  surface. The route needs a rate limit before it is exposed.
- **No key rotation story for the caller**: rotating produces a new secret
  and the old one stops working, but nothing tells a caller that the old
  one is dead until it gets a 401.
- The organisation record is the only thing a key can read, so the key's
  usefulness is bounded by how much the organisation record says. That is
  a product decision to revisit with the sponsor console, not a
  technicality.

## References

- `apps/api/src/api-key-auth.ts` — the presentation, the verification, the refusals
- `apps/api/src/orgs.ts` — `resolveOrgReader`: a wallet session OR the organisation's own key
- `apps/api/test/{api-key-auth,api-key-routes}.test.ts`
- `docs/adr/0040-a-revoked-key-must-not-come-back.md`
