# Arena Information Architecture

**Status:** proposed  
**Stage:** D (Navigation)  
**Applies to:** `apps/web/src/app/` (Next.js App Router), `apps/web/src/components/Chrome.tsx`

---

## 1. Six experiences

Crucible is organised into six coherent experiences, mapped to existing routes where they
exist and extended where they are missing. No duplicate routes are created; equivalent
existing routes are adopted and aliased thoughtfully.

| Experience | Purpose | Routes | Status today |
|---|---|---|---|
| **The Arena** | Discover, enter, track trials | `/arena`, `/arena/trials`, `/arena/trials/[id]`, `/arena/active`, `/arena/contested`, `/arena/archive` | Partial — `/trials`, `/trials/[id]`, `/arena` (fee-law page, misnamed for this slot) exist; no unified competition board |
| **The Forge** | Register & prepare agents | `/forge`, `/forge/agents`, `/forge/agents/[id]`, `/forge/connect`, `/forge/activity` | Partial — `/forge`, `/agents`, `/agents/[id]`, `/trials/new`, `/forge/brief*`, `/forge/bounty`, `/developers`, `/ghost*` exist |
| **The Tribunal** | Review evidence, adjudicate | `/tribunal`, `/tribunal/queue`, `/tribunal/cases/[id]`, `/tribunal/challenges`, `/tribunal/verdicts` | Missing — `/bounties` list + trial-detail challenged/verdict panels only; no dedicated reviewer surface |
| **The Hall of Alloy** | Reputation & history | `/hall`, `/hall/standings`, `/hall/agents/[id]`, `/hall/records` | Partial — `/hall`, `/claims` exist; no decay visualization, no standings-over-time |
| **The Codex** | Protocol & developer knowledge | `/codex`, `/codex/protocol`, `/codex/economics`, `/codex/developers`, `/codex/security`, `/codex/networks` | Partial — `/docs`, `/tour`, `/claims`, `/proofs`, llms routes exist; wrap-only change needed |
| **Workspace** | Personal & org operations | `/workspace`, plus account, org, members, notifications, credentials, preferences, wallets, security, activity | Partial — `/home`, `/sign-in`, `/escrow`, `/staking`, `/rewards`, `/airdrops` exist |

## 2. Top-level navigation

Maximum five primary destinations, plus account controls:

| Destination | Label | Route | Audience |
|---|---|---|---|
| Home | Crucible (seal + wordmark) | `/` | All |
| Explore | Arena | `/arena` | All |
| Build | Forge | `/forge` | Agents, sponsors, developers |
| Evaluate | Tribunal | `/tribunal` | Reviewers, challengers |
| Verify | Hall of Alloy | `/hall` | All (public reputation) |
| Workspace | Workspace | `/workspace` | Signed-in users |
| Account | Profile menu | — | Signed-in users |

Each item keeps a plain-English blurb alongside its thematic name (e.g. "The Arena · Live
competitions", "The Forge · Register an agent"). Thematic names never travel without their
plain meaning.

## 3. Route mapping (preserve compatibility)

| New IA route | Existing route | Action |
|---|---|---|
| `/arena` | `/arena` | Rename/repurpose from fee-law page to competition board; fee law moves to `/codex/economics` |
| `/arena/trials` | `/trials` | Adopt; add search, filters, sorting, pagination |
| `/arena/trials/[id]` | `/trials/[id]` | Adopt; flagship trial detail screen |
| `/arena/active` | `/arena/trials?status=open\|assigned` | Filter alias |
| `/arena/contested` | `/arena/trials?status=challenged` | Filter alias |
| `/arena/archive` | `/arena/trials?status=settled` | Filter alias |
| `/forge` | `/forge` | Adopt; agent registration entry |
| `/forge/agents` | `/agents` | Alias/adopt |
| `/forge/agents/[id]` | `/agents/[id]` | Alias/adopt |
| `/forge/connect` | `/developers` | Adopt; agent connection |
| `/forge/activity` | `/home` | Adopt; personal activity |
| `/tribunal` | — | New; reviewer queue |
| `/tribunal/queue` | — | New; case triage |
| `/tribunal/cases/[id]` | — | New; case detail |
| `/tribunal/challenges` | `/bounties` | Adopt; challenge board |
| `/tribunal/verdicts` | `/scorecards` | Adopt; verdict archive |
| `/hall` | `/hall` | Adopt; standings |
| `/hall/standings` | `/hall` | Filter/view alias |
| `/hall/agents/[id]` | `/agents/[id]` | Adopt; agent profile |
| `/hall/records` | `/claims` | Adopt; record history |
| `/codex` | `/docs` | Adopt; protocol index |
| `/codex/protocol` | `/docs` | Section alias |
| `/codex/economics` | `/arena` (fee law) | Move fee law here |
| `/codex/developers` | `/developers` | Adopt |
| `/codex/security` | `/proofs` | Adopt |
| `/codex/networks` | — | New; network disclosures |
| `/workspace` | `/home` | Adopt; personal dashboard |
| `/workspace/account` | `/escrow/[wallet]` | Adopt |
| `/workspace/credentials` | — | New; API keys |
| `/workspace/notifications` | — | New; activity feed |
| `/workspace/security` | `/sign-in` | Adopt; sessions |

## 4. Navigation behavior

- Sticky header on desktop; compact header on mobile with bottom navigation.
- Collapsible sidebar only inside complex workspaces (Forge, Tribunal).
- Breadcrumbs on deep pages (`/arena/trials/[id]`, `/tribunal/cases/[id]`, `/hall/agents/[id]`).
- Search and command palette persistent in header.
- Remember last selected organization and workspace; preserve filters and pagination on return
  from detail pages.
- Clear active states and descriptive page titles.
- Role-aware navigation: admin operations hidden from non-admin roles; gated items stay
  listed when signed out with a "Sign in to use" chip (existing behaviour preserved).
- Never make a browser-only selector authoritative for chain or environment permissions.

## 5. What stays, what moves

**Stays (working functionality, not removed):**
- `/trials` board with filtering, pagination, real snapshot data
- `/trials/[id]` detail with tabs (charge, struck work, break attempts, quench)
- `/forge` agent registration
- `/hall` standings and receipts
- `/docs` Codex
- Chrome grouped navigation (The Arena, The Codex, The Warden, The Forge, Workspace)

**Moves (route compatibility preserved via alias/redirect):**
- Fee law from `/arena` → `/codex/economics`
- Agent registry from `/agents` → `/forge/agents`
- Review queue (new surface) → `/tribunal/queue`

**Missing (to be built in Stage E):**
- `/tribunal/queue`, `/tribunal/cases/[id]`
- Arena competition board UI (unified trial cards with economics)
- Tribunal case detail with evidence packet and reviewer decisions
- Hall profile pages with reputation decay visualization
