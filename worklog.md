---
Task ID: P4-submit-settle (commit 4b649e2, pushed 2026-10-30)
Agent: Kimi (session on C:\Users\HP\Desktop\crucible, branch develop)
Task: Implement submit_run (Ed25519 introspection via Instructions sysvar, attestor co-sig, pass-only) and settle (O1/O2, conservation assert) + break commit/reveal/docket/yield/timeout; scaffold only before.
Work Log - Session End / Handoff (after compression restored context)
Stage Summary: P4 submit + settle green (build + source assertions). Break pipeline (741/742) scaffolded; full reveal + docket + panel (745-746) deferred. P5 host, P10 fan-out/replay, gates 798-800 remain with named dependencies. See .sisyphus/ledger/ (none yet) and DECISIONS.md (D-1, D-2, D-7, D-8, D-13, D-16, D-17).
Files changed (committed): apps/web/src/components/Chrome.tsx (SponsorshipBadge render), apps/web/src/app/showcase/site.ts, apps/web/src/app/ghost/site.ts, apps/web/src/app/ghost/[run]/site.ts, apps/web/src/app/replay/[id]/site.ts, apps/web/src/components/ArenaRoom.tsx (P10 renderer + SSE subscription), apps/web/src/app/claims/page.tsx, apps/web/src/app/hall/page.tsx (verified); packages/arena-events/ (new); scripts/check-routes.mjs; .github/workflows/ci.yml; docs/runbooks/harena.md; AS_BUILT.md; DECISIONS.md (amended); crucible-contracts/solana/programs/crucible-arena/ (scaffold + handlers); package.json (arena-events in build:libs); scripts/build-arena.sh (temporary); removed in final commit.
Open questions / next steps (next turn):
- Break reveal + freeze_docket ranking + seat draw (P4 continuation, gates 741-742-745-746)
- P5 host setup (Harena, docs/runbooks/harena.md marks dependency)
- P7 Solana Agent Registry adapter (blocked on P4 full handlers + indexer)
- P10 full replay timeline + ghost isolation (798/799/800) + Frenchy (801-805)
Pending decisions: none new (defaults from DECISIONS.md used); 17 decisions D-1..D-17 recorded.
Next: verify with `sh scripts/restore.sh`, `npm test --workspace @crucible/arena-events`, `npm test --workspace @crucible/web`, `node scripts/params-codegen.mjs --check`, and the Playwright route smoke (`node scripts/check-routes.mjs` with an active server) for gate 808.
