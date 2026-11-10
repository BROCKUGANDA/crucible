# Arena Redesign — Test Report

**Date:** 2026-11-10  
**Branch:** `feat/arena-evolution-stage-a-e`  
**Base of branch:** `develop` (a5d6759) merged in  
**Verifies:** the arena brand/component/listing/case-file work plus the parallel arena work this branch carries

---

## 1. What was run

| Check | Command | Result |
|---|---|---|
| Web typecheck | `npx tsc --noEmit` (apps/web) | **Clean** — 0 errors |
| Web lint | `npx eslint src test` (apps/web) | **0 errors**, 48 warnings (all pre-existing, incl. `useTx.ts` immutability and Chrome `set-state-in-effect`; none from new files) |
| Web unit/route tests | `npx vitest run apps/web/test/` | **290 passed, 2 failed** — the 2 are pre-existing `@/lib/site` alias-resolution failures in `landing-claims.test.ts`, identical on develop |
| Site index tests | `packages/site-index/test/site-index.test.ts` | **23 passed** (after regenerating `generated.ts`, 53 entries) |
| Route coverage | `test/route-coverage.test.ts` | **3 passed** |
| No inline styles | `test/no-inline-styles.test.ts` | **pass** |
| Copy gates | `test/copy.test.ts`, `claims-registry`, `landing-claims` | **pass** with the 2 pre-existing failures noted |
| arena-view / arena-facts | `vitest` | **pass** (alias-resolution suites fail to load in this workspace, pre-existing) |

## 2. What was NOT run, and why

| Check | Reason not run |
|---|---|
| `npm run verify:all` (full) | Not run: forge/contract suites untouched by this branch; the tree carries foreign uncommitted Solana work (`apps/web` has none) that was not mine to include or test |
| Foundry suite | No contract files were modified by this task |
| Keyboard walk / axe | Not configured in this repo; manual semantics/ARIA review only — see §4 |
| Performance measurement | No Lighthouse run performed; targets unmeasured |
| Live-data journeys | The local API/Anvil stack was not running in this environment — chain-dependent views were browser-verified only in their degraded states |

## 2b. Browser verification (2026-11-10, clean build 9d00019)

Verified in Chromium against a production build served on a port-3100
worktree off the branch (the shared port-3000 server was not touched):

- `/` — hero renders server-side; "THE ARENA DOES NOT REWARD PROMISES.",
  seal, architectural artwork, CTAs ("Enter the arena" → `/trials`,
  "Read the codex" → `/docs`), six acts, glossary, fine print — all present
  without JS and with the API down (the scrub scene paints, copy stands)
- `/trials` — Arena listing: header with seal, search panel (accessible
  name verified), status filter chips, honest cold-forge empty state with
  "Post a trial" CTA; `trial-table` anchor id intact for Frenchy's grounding
- `/trials/1` and `/tribunal/cases/1` — degrade to the honest "Couldn't
  reach the chain" panel with full chrome, no hydration faults
- Console: only the EventSource MIME mismatch (API not listening) and the
  pre-existing CSP rejections of Coinbase's metrics beacons
- NOT verified with chain data flowing; the full visitor/agent/sponsor
  journeys require the local demo stack (Anvil + API) which was not started

## 3. Known failures (not mine, not fixed here)

| Failure | Symptom | Status |
|---|---|---|
| `landing-claims.test.ts` allowlist (×2) | `Cannot find package '@/lib/site'` from `.well-known/crucible.json/route.ts` | pre-existing; fails identically on `develop`; vitest resolution, unrelated to redesign |
| 22 suite-level "Cannot find package '@/…'" errors | vitest cannot resolve Next path aliases in this workspace | pre-existing workspace condition; suites load 0 tests, not failing assertions |

## 4. Accessibility/semantics review (manual)

- Interactive chips/filters use `aria-pressed`; tablist uses APG roving tabindex (pre-existing pattern preserved).
- Verdict stamps carry glyph + label, never colour alone.
- Empty/error states are labelled (`role="region"`/`role="alert"`).
- Tables use `scope="col"`, `aria-rowcount` numeric, `grid` role with concise labels.
- Focus-visible ring is global (tokens); reduced-motion kill switches preserved and extended.
- **Not verified:** contrast of the new `--arena-bronze` text uses on actual pages; no axe/keyboard walk was executed; the new case page was not navigated in a browser.

## 5. Responsive

CSS added for ≤700px: stacked header, grid drops to one column,
`case-grid`/`execution`/`activity` rows collapse to single column, table cell
padding shrinks, touch targets ≥44px preserved from base tokens. **Not
measured** on real devices.
