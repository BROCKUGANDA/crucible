# Arena Current State Audit — Stage A

Status: **Discovery audit (Stage A of the Arena Evolution directive).** Verified against
the tree after `8828fe5` (2026-11-09). Classifications: **implemented** (live API/chain
data), **partial** (real data, incomplete flow), **UI-only/simulated** (client-side
simulations, self-labeled), **stub** (honest placeholder naming a future phase).

## 1. Route inventory

~49 pages + route handlers. Data layer: `useSnapshot()` (SSE `${API_BASE}/stream` with
`/snapshot` polling fallback, `src/lib/useSnapshot.ts:148,79-90`).

### Implemented (live data)

`/` (six-act landing, copy static + real live feed), `/agents`, `/agents/[id]`,
`/airdrops` (test-ETH faucet → real API), `/assay` (health/ready), `/bounties` (judging
trials), `/claims` (curated static, test-backed), `/clock` (constants live from contract),
`/content/[id]`, `/data`, `/engineering`, `/finance` (real endpoints, demo fixtures in
page), `/escrow/[wallet]`, `/faucet`, `/forge`, `/forge/bounty`, `/forge/brief`(+`[id]`),
`/hall`, `/home`, `/rewards`, `/scorecards`, `/sign-in`, `/staking`, `/teams`,
`/tour`, `/treasury`, `/trials`, `/trials/new`, `/trials/[id]` (+replay/reproduce),
`/verify`, `/voice`, `/solana` (read-only devnet console, partial).

### Partial / host-dependent

`/arena` (real API read; often renders "not on this host" — it is the fee-law page, not
the competition board the Arena name implies), `/teams` (same projection caveat),
`/ghost/[run]` (depends on a separate fork host, default localhost).

### UI-only / simulated (all self-labeled — keep the labels)

`/engrams` — entitlements are real (`GET /engrams/me`), but rarity/Surge/open-hold is a
client-side mixer + localStorage; disclaimers at `engrams/page.tsx:205-224`. `/demo` —
fully seeded, labeled. `/ops`, `/proofs` — static honesty pages (deliberate).

### Stubs (honest)

`/ghost` ("fork host lands with P5"), `/showcase` ("live room lands with P5/P8"),
`/replay/[id]` (theater door — not the working `/trials/[id]/replay`).

**Unwired:** `components/ArenaRoom.tsx` (trial-scoped SSE) exists but no page imports it.

## 2. Truthfulness flags on the landing page (now fixed in this commit)

| Claim | Was | Now |
|---|---|---|
| Lede | "with real money behind it" — false on demo (test ETH) | "with skin in the game" + demo-money note comment; claims registry row III-1 kept in sync |
| Eyebrow | "every verdict on-chain" | "verdicts settled on-chain" (challenged verdicts go through committee; docs/page.tsx:66-70) |
| Act III | "sealed sandbox" | "sandboxed environment… not certified hostile-code containment — limits named on /proofs" (registry copy updated to match) |

The fine print (`page.tsx:318-323`) and `/ops` already disclose the demo; the hero no
longer contradicts them.

## 3. Design tokens

Palette is complete and good: grounds `--bg0/1/2`, ink `--text/--dim/--faint`, states
`--ember/--gold/--hot/--quench/--sear/--ash`, materials `--marble/--bronze/--sand/--tyrian`,
semantic `--success/--warning/--error/--info/--pending`, plus fonts (Cinzel display,
grotesque body, JetBrains Mono), spacing, easings, durations. Drift-asserted by tests
against TS mirrors (`src/lib/forge.ts`, `src/lib/scrub/palette.ts`).

**Added in this commit:** an `--arena-*` semantic alias layer (`tokens.css`) mapping the
directive's names (`--arena-background`, `--arena-surface`, `--arena-surface-raised`,
`--arena-stone`, `--arena-marble`, `--arena-bronze`, `--arena-gold`, `--arena-ember`,
`--arena-success`, `--arena-warning`, `--arena-danger`, `--arena-muted`,
`--arena-border`, `--arena-focus`) onto existing tokens. No new color values; pages adopt
incrementally.

## 4. Visual system (to preserve)

`ScrubStage` scroll-scrubbed canvas (mark/crowd/seal from live snapshot), `arena__act`
sections (100svh, bottom-anchored copy, radial scrim), `arena__term` dl grids, Cinzel act
titles, reduced-motion kill switch (`arena.css:480`). The directive's own advice — do not
throw this away — is correct: this is the most distinctive asset in the product.

## 5. Mapping to the six experiences

| Experience | Wraps today | Gap |
|---|---|---|
| **The Arena** | `/trials`, `/trials/[id]` (+replay/reproduce), `/bounties`, `/arena` (fee law — misnamed for this slot) | trial cards lack name/sponsor/verification-method fields; no unified competition board |
| **The Forge** | `/forge`, `/agents(/[id])`, `/trials/new`, `/forge/brief*`, `/forge/bounty`, `/developers`, `/ghost*` | solid |
| **The Tribunal** | `/bounties` list + trial-detail challenged/verdict panels only | **no dedicated surface** — no committee/reviewer view, no commit/reveal timeline, no verdict archive page (scorecards is closest) |
| **The Hall of Alloy** | `/hall` (tiers, receipts, settlement txs), `/claims` | no decay visualization, no standings-over-time |
| **The Codex** | `/docs`, `/tour`, `/claims`, `/proofs`, llms routes | wrap-only change |
| **Workspace** | `/home`, `/sign-in`, `/escrow`, `/staking`, `/rewards`, `/airdrops`, `/faucet` | solid |

**Navigation (done in this commit):** Chrome's grouped menu now carries the arena naming —
navbar: Workspace / Trials / Arena / **Hall of Alloy** / **Purse · Escrow**; groups: **The
Arena**, **The Codex**, **The Warden · For operators**, **The Forge · For vendors &
developers**, **Workspace** — each item keeps a plain-English blurb, thematic names never
travel without their plain meaning (e.g. "The Codex · Docs", "The Watch · Status").
`copy.test.ts`'s old "Hall of Alloy" ban was lifted deliberately with the gloss rule; all
other bans stand.

## 6. Known simulated surfaces (never present as real)

1. `/engrams` game layer (client mixer, localStorage) — disclaimed on-page.
2. `/demo` — seeded walkthrough.
3. `/data`, `/finance`, `/engineering` — real endpoints, demo fixtures.
4. Solana payment proofs — devnet fixtures by design.
5. `/ghost`, `/showcase`, `/replay/[id]` — stubs that name their phase.

## 7. Accessibility / performance posture (baseline)

- Reduced-motion: JS hook + CSS kill switches in 6 stylesheets.
- Focus-visible global + component-level; trial tabs implement APG roving tabindex.
- No virtualization; trials page does manual windowing; content page truncates at 200k.
- Hero preview deliberately avoids a second EventSource; clock batches `useReadContracts`.

## 8. What the redesign must not break

- The copy tests (`copy.test.ts`, `claims-registry.test.ts`) — the registry asserts the
  landing page actually carries every "site copy" row it cites. Any copy change must
  update the registry in the same commit (this cost one red test today before sync).
- `route-coverage.test.ts` asserts footer `/claims` and `/verify` links.
- The scrub canvas depends on live snapshot facts (`deriveFacts`) — the "activity" the
  directive wants partially exists here already.
