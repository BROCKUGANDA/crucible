# ADR-0022 — Organisation and Tenancy Foundation

**Status:** Accepted  
**Date:** 2026-11-05  
**Branch:** `develop`

## Context

CRU-005 requires an organisation-aware identity model: organisations, workspaces,
memberships, invitations, roles, permissions, resource ownership and audit identity.

The existing `packages/agent-security` already defines agent-side principals,
roles, credentials, permissions and audit-log primitives, but it has no concept
of an organisation, workspace, or tenant boundary. The API's SIWE session
(`apps/api/src/auth.ts`) proves control of a wallet address and nothing else —
there is no organisation context on any request.

## Decision

1. **Organisation/tenancy entities live in `packages/agent-security`.**
   The package is already the identity/authorization/access-control boundary,
   is built and tested, and importing it into the API requires no new workspace
   or package-manager change. Agent principals (CRU-005's "agent" identity) and
   organisation principals (wallet-bound members) share the same `Principal`
   type, so one `Decision`/`DenialCode` vocabulary covers both.

2. **In-memory stores, consistent with ADR-0008.**
   The indexer is in-memory (ADR-0008) and no database or queue may be added
   without a new ADR. Organisation state therefore uses `globalThis`-backed
   `Map` stores, the same pattern `auth.ts` uses for challenges and sessions.
   A single-process deployment owns the org store; a multi-process deployment
   moves it to a shared store without changing the entity or authorization
   interface. Persistence is explicitly deferred: ADR-0008's choice stands until
   a new ADR justifies it.

3. **Wallet principal is the identity; organisation is scope.**
   An organisation membership is bound to an existing wallet principal (the
   SIWE-authenticated address). A client-supplied `orgId` is never trusted as
   proof of membership — membership is read from the store per request and the
   session principal is the source of truth. A session proves `who`; the org
   store answers `what they may do in which org`.

4. **Settlement never depends on organisation infrastructure.**
   On-chain settlement (`withdraw()`, `finalize()`, `reclaimExpired()`) is
   permissionless and wallet-signed. An organisation-store outage fails closed
   for protected org writes but never blocks on-chain settlement (AGENTS.md,
   collaboration-and-governance.md §1).

5. **Ten-role matrix from collaboration-and-governance.md §3**, enforced at the
   service layer, not merely documented:
   org owner, billing admin, benchmark author, evaluator, runner operator,
   reviewer/skeptic, auditor, read-only analyst, external collaborator,
   platform operator. Separation-of-duties rules are enforced (author≠publisher
   for public benchmarks; operator≠evaluator for own-run grading; billing admin
   cannot grant themselves a role).

6. **Invitations are time-boxed, project-scoped, domain-restricted, revocable.**
   Default role on accept is the lowest that grants access. Revocation takes
   effect at the next request (permissions read per request, not cached in the
   session token).

7. **COI (conflict-of-interest) register** for operators and jurors, checked
   before Argus seat assignment and before a reviewer grades a submission from
   an affiliated principal.

8. **No chain keys, no funds held.** The org model holds access, scope and
   evidence — never ETH or SOL. Money moves only when a participant signs for
   it (ADR-0006, ADR-0003).

## Consequences

- New API mutation routes need organisation-aware authorization before they may
  write. Read routes that return org-scoped data must filter by the session's
  proven memberships.
- Cross-organisation isolation must be proven by negative tests (Org A cannot
  read Org B's records at API, storage, artifact and execution boundaries).
- The API's no-chain-key property is preserved: org membership does not give
  the server a key that can move a participant's escrowed ETH.
- A new ADR is required before any persistent store, database, or queue is
  introduced for organisation data.

## Alternatives considered

- **New package `@crucible/org`:** rejected — adds workspace config, build
  plumbing and a second identity boundary for no gain; `packages/agent-security`
  already owns principals, roles, permissions and decisions.
- **Postgres + RLS:** rejected — ADR-0008 defers persistent store; no evidence
  scale is binding yet; a database would introduce a second source of truth for
  org state beside the chain-derived read model.
- **Client-supplied orgId trusted:** rejected — IDOR class vulnerability;
  membership is store-derived per request.

## Evidence

- `packages/agent-security/src/organisation.ts` — entity types
- `packages/agent-security/src/org-store.ts` — in-memory store
- `packages/agent-security/src/org-principal.ts` — server-side principal resolver
- `packages/agent-security/src/org-authz.ts` — authorization middleware
- `packages/agent-security/src/org-roles.ts` — ten-role matrix + separation of duties
- `packages/agent-security/src/org-coi.ts` — conflict-of-interest register
- `packages/agent-security/test/org-store.test.ts`, `org-authz.test.ts`, `org-roles.test.ts`, `org-coi.test.ts`
- `docs/enterprise/collaboration-and-governance.md` §3 — role matrix source
- `docs/enterprise/roadmap.md` — S4 gate (tenant isolation at every layer)