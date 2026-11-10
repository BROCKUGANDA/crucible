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
| `npm run verify:all` (full) | Not run: forge/contract suites untouched by this branch; running the whole 3,700-test suite here would re-verify unchanged code paths, and the shared tree currently carries foreign uncommitted work (`apps/api/src/tx-store-pg.ts`, `apps/web/e2e/`) that was not mine to include |
| Foundry suite | No contract files were modified by this task |
| E2E (browser) | **Not executed** — the shared production `next start` (PID 22296) at `:3000` serves the old build; rebuilding `.next/` under a running server was not authorized. Browser verification of new screens is outstanding |
| Accessibility tooling (axe) | Not configured in this repo; no automated a11y gate exists. Manual semantics/ARIA review only — see §4 |
| Performance measurement | No Lighthouse run performed; targets unmeasured |

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
