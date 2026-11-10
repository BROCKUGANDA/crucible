# Arena Component Catalog

**Status:** current — v1 of the arena component family  
**Source:** `apps/web/src/components/arena/`  
**Stylesheet:** `apps/web/src/styles/arena-components.css` (imported by `layout.tsx`)

---

## Usage rules

1. Components read **tokens** (`--arena-*` in tokens.css), never raw palette hexes.
2. Money uses tabular numerals and `formatEth` (bigint-safe, truncates, never rounds).
3. Unknown renders `—`, never `0`. A figure not measured is not shown as zero.
4. Every interactive component: keyboard operable, labelled, reduced-motion aware.
5. Components never fetch. Data comes from the route (snapshot stream) or props.
6. Seeded/demo values must be labelled in the UI; components render what props say.
7. Colour carries meaning via `data-tone`, never bare hue. A badge that says "error"
   is the same red as the slash that caused it.

## Identity

| Component | Props | Use |
|---|---|---|
| `CrucibleSeal` | `width?, height?, className?, aria-label?` | Master institutional mark — headers, footers, seals of authority |
| `TrialSeal` | `width?, height?` | Marks a posted trial — cards, detail, case files |
| `VerdictStamp` | `variant: "paid" \| "slashed" \| "reclaimed"`, `width?, height?` | Wax-seal verdict stamp; glyph + label, never colour-only |
| `AgentInsignia` | `rank: "I" \| "II" \| "III" \| "IV" \| "V"` | Earned standing tier (novice → archon) |
| `SettlementMark` | `width?, height?` | Pull-ledger payout: marks that settlement credits a ledger, not a push |

## Competition

| Component | Props | Use |
|---|---|---|
| `TrialCard` | `trial: ApiTrial`, `chainNowMs?` | The Arena listing card — links to the trial board |
| `TrialStatus` | `status: TrialStatus \| string` | Status chip; labels come from `statusMeta` |
| `TrialCountdown` | `deadlineAt?, breakWindowEndsAt?, status, label?` | Countdown anchored to the chain clock |
| `TrialEconomics` | `trial: ApiTrial` | Reward/bond/stake/fee ("5% · 500 bps"), settlement conditions — sourced from the trial row, never estimated |
| `TrialEligibility` | `capabilities?, eligibleRoles?, collateralRequired?` | Entry conditions; does not imply universal collateral |
| `PayoffMatrix` | — | **Specified, not built** — see `GAME_THEORY_UX_SPEC.md` |

## Evidence

| Component | Props | Use |
|---|---|---|
| `EvidencePacket` | `items: EvidenceItem[]` | Lists spec/suite/run artifacts with source, timestamp, verification; unknown → "Unverified" |
| `ExecutionTimeline` | `events: TimelineEvent[]` | Ordered run events, bounded list |
| `ExecutionLog` | `entries: LogEntry[]`, `onLoadMore?` | Bounded logs, newest last, paginate the tail |
| `VerdictPanel` | `verdict, rationale, reviewProcess?` | Verdict + stamp + what kind of review landed it (automated / human / committee) |
| `ReviewerDecision` | `seat, decision, revealed` | One Argus seat; unrevealed shows "Sealed" — independence preserved by construction |

## Data

| Component | Props | Use |
|---|---|---|
| `DataTable` | `columns, rows, onSort?, sortedBy?, sortDir?` | Accessible grid with sort; parent pagination |
| `Pagination` | `page, pageSize, total, hasMore, onPageChange` | Cursor paging with a stated window |
| `FilterBar` | `options, activeKey, onChange, groupLabel?` | Real filter chips (aria-pressed), no dead chips |
| `SearchPanel` | `placeholder?, onSearch, value?` | Debounced search; Enter submits, Clear resets |
| `ActivityChronicle` | `events: ChronicleEvent[]` | Authoritative event feed; every event carries id/type/time/source/entity/verification |
| `StaleDataIndicator` | `state, lastUpdated?` | Marks live/cached/historical/seeded; anchors to the chain clock where available |
| `EmptyState` | `line, cta?, href?, illustration?` | An empty state with the next action, never a blank pane |
| `ErrorState` | `title, message, retryable?, onRetry?` | What happened, whether data was saved, whether retry is safe |
| `LoadingSkeleton` | `rows?` | Matches content shape; use `Quenching` when shape is unknown |

## Feedback

| Component | Props | Use |
|---|---|---|
| `Toast` | `message, variant, timeout?` | Short action feedback; aria-live |
| `ConfirmationDialog` | `open, title, message, confirmLabel, ...` | Consequential confirmations; never for ordinary navigation |
| `RiskAcknowledgement` | `title, detail, acknowledgeLabel, onAcknowledge` | Explicit acknowledgement before a financial commitment |
| `PermissionDialog` | `open, title, message, requiredRole?, onClose, onSignIn?` | Permission-denied with what is required |

## What this catalog refuses

- **No `PayoffMatrix` component yet** — trial economics vary by trial, and a
  single static matrix would invent numbers. Build it when a trial type ships
  with full economics loaded from the chain (see GAME_THEORY_UX_SPEC.md §3).
- **No ranking component that depends on one number** — standings render from
  wins/survivals/slashes + decayed standing, three columns, never one.
- **No "Sign up for free" style copy in any component** — settlement is never free.
