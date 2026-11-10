# Arena Implementation Plan

**Status:** current — tracks the ARENA_EVOLUTION directive's stages  
**Branch:** `feat/arena-evolution-stage-a-e`  
**Base:** `develop` (a5d6759 at time of writing; branch includes 62724fe, 603e637, tribunal-case commit)

---

## Stage status

| Stage | Deliverable | Status | Notes |
|---|---|---|---|
| A | Discovery — `docs/design/ARENA_CURRENT_STATE_AUDIT.md` | Done (pre-existing) | verified against the tree; the `--arena-*` alias layer landed in 9256a5a |
| B | Design foundations — tokens, identity assets, components | **Done** | tokens pre-existed + alias layer; brand family created; 22-component arena family; `arena-components.css` |
| C | Homepage — six acts, architectural art, primary CTAs | **Done** | hero carries "THE ARENA DOES NOT REWARD PROMISES." + seal + architectural artwork; act copy preserved verbatim against copy tests |
| D | Navigation — six-experience architecture | **Partially done** | Chrome primary row now Workspace/Arena/Tribunal/Hall of Alloy/Purse; groups: The Arena, The Forge, The Hall, The Codex, The Warden, Workspace; route aliases evaluated; `/tribunal` exists; `/tribunal/cases/[id]` added |
| E | Signature screens | **Partially done** | Arena listing ✓ (cards, search, filters, pagination, stale-data); Trial detail — pre-existing flagship + CommitteeClock (parallel) + TrialEconomics (parallel); Execution room — the trial detail struck-work/replay path + `arena-room` SSE scaffold exists but is unwired by design; Tribunal case file ✓ new; Hall — pre-existing + faded-standing (parallel) |
| F | Game theory — Strategium | **Spec done only** | `GAME_THEORY_UX_SPEC.md`; no PayoffMatrix (deliberately; see spec §3) |
| G | Motion | **Partially done** | reduced-motion kill switches; seal drop-shadow; hero scroll cue; motion tokens pre-existing |
| H | Hardening / E2E | **Partially done** | web suite green; no dedicated a11y/perf pass; no new E2E specs |
| I | Release | **Not authorized** | no deploy performed |

## Dependencies and ordering

1. B → C/D/E (tokens and components before screens)
2. E → F (case file and board feed Strategium economics display)
3. G after screens stabilize
4. H throughout
5. I requires explicit authorization; local verification is not release

## Risks

- **Shared working tree** — another session committed `feat(arena): Tribunal surface…`
  and `feat(trials): CommitteeClock…` on this branch mid-flight; files aligned by merge
  (see git log). Any further parallel commits can silently overwrite component files;
  every commit must re-check `git status` for foreign edits.
- **Copy tests bind the hero** — `landing-claims.test.ts`, `copy.test.ts` and
  `claims-registry.test.ts` fail on wording drift; copy changes need registry sync.
- **Site index is generated** — every new route needs a `site.ts` and
  `npm run site-index`, or `packages/site-index/test/site-index.test.ts` goes red.
- **State of the production `next start` process** — the shared server at :3000
  serves the old build; nothing in this branch has been browser-verified on it.
- **Not merged to `develop`** — branch carries everything; `develop` was merged in.
  Merging into develop is the deploy; do not merge without authorization.

## Next slices (proposed, in order)

1. Wire the execution room: one tab on `/trials/[id]` rendering `ArenaRoom` against
   the real `/trials/:id/events` SSE, plus CSS for `arena-room`.
2. `PayoffMatrix` once contract constants are exposed to the client from a single
   source (params or a `/rules` endpoint), with binding tests.
3. Hall decay visualization (component exists: `DecayCurve`) — needs settlement
   timestamps indexed for per-agent age (not done; see `faded-standing.ts`).
4. Dedicated `/tribunal/queue` (sorted by `disputeOpenedAt`) and `/tribunal/verdicts`
   as aliases of the existing scorecards, if the IA test matrix demands them.
5. `docs/engineering/ARENA_TEST_REPORT.md` refresh after each verification run.
