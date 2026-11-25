# The door that accepts an API key — and how narrow it is on purpose

**Date**: 2026-11-20
**Branch**: `develop`
**ADR**: 0041 (`docs/adr/0041-an-api-key-reads-its-own-organisation-and-writes-nothing.md`)

## Why this slice

ADR-0040 made the API keys durable and named what was still missing:
**nothing authenticated with them**. The commercial promise ("your team
polls the API with a key") was not yet true.

## What was built

| File | What it is |
|---|---|
| `apps/api/src/api-key-auth.ts` | the presentation, the verification, the refusals |
| `apps/api/src/orgs.ts` | `resolveOrgReader`: a wallet session OR the organisation's own key |
| `apps/api/src/api-contract.ts` | `revoked`, `expired`, `wrong-scope`, `key-not-for-this-org` |
| `apps/api/test/api-key-auth.test.ts` | the credential (6 tests) |
| `apps/api/test/api-key-routes.test.ts` | the routes (5 tests) |

## The decisions

- **The presentation** is `Authorization: Bearer crux.<secret>`; the
  lookup prefix is derived from the secret (never carried separately, so
  the two cannot disagree).
- **Three refusals stay three facts**: revoked / expired / wrong-secret
  are 401s; a missing scope is a 403 that names the scope; another
  organisation is `key-not-for-this-org`.
- **A key reads its own organisation and writes nothing.**
- The surface is deliberately two routes: `GET /orgs/:id` and
  `GET /orgs/:id/api-keys`.

## Evidence

- 11 API tests; **6/6 mutations proven red**
  (`.scratch/mutate_api_key_auth.py`).

## Two lessons recorded (both are the repo's own rules)

1. **A test that passes for the wrong reason.** The wrong-secret test
   presented a secret with a DIFFERENT PREFIX — which is never found at
   all, so it passed without ever comparing the secret. It now presents
   one with the same prefix and a different body: the key is found, and
   the SECRET refuses it.
2. **The instrument can lie about the product.** The mutation that
   disables the secret comparison lives in the PACKAGE, and the API's
   tests import the BUILT package — so the script rebuilds before the
   test **and again after restoring the source**. A restore that leaves
   the build mutated turns the next plain run into a red test that is not
   there. This was caught: a plain run answered HTTP 200 to a wrong
   secret, because the mutated build was still in `dist/`.

## Still open, named

- The surface is two routes (the sponsor's ledger, the trials, the
  publications and the disputes are wallet-only).
- An endpoint that spends ~80 ms verifying a secret needs a rate limit.
- No server-side pepper (ADR-0040).
- Budgets/quotas and webhook endpoints: still in process memory.
- REPL-D2, the RLS role split, the review verdict, hold timeouts.
