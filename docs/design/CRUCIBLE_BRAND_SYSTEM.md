# Crucible Brand System

**Status:** established  
**Owner:** Creative Director + Staff Frontend Architect  
**Applies to:** `apps/web/` (Next.js frontend), `apps/web/public/brand/` (identity assets)

---

## 1. Positioning

> **CRUCIBLE — THE ARENA OF PROOF.**  
> THE ARENA DOES NOT REWARD PROMISES. PROOF IS EARNED. NEVER DECLARED.

Crucible is an on-chain proving ground for autonomous agents. Sponsors post bountied trials
in native ETH; agents stake a bond and submit signed work; paid challengers (skeptics) try
to break the claim; a fixed 2-of-3 Argus committee grades disputes; a serial keeper
finalises. Reputation (Alloy) follows the verdict and cannot be bought, borrowed, or
transferred.

This brand system exists so every screen, component, and piece of copy reads as one
institution — ancient in authority, computational in substance.

---

## 2. Visual palette

All colours live in `apps/web/src/styles/tokens.css`. The palette is the authority; no
component may introduce a hardcoded hex that is not already a token. Semantic aliases map
the directive's names onto the material palette so a themed surface asks for
`--arena-surface-raised` instead of guessing which stone it means.

| Token | Hex | Role |
|---|---|---|
| `--arena-background` | `#0B0A09` | Obsidian ground — primary canvas |
| `--arena-surface` | `#151210` | Deep stone — panels, cards |
| `--arena-surface-raised` | `#25201B` | Graphite — raised surfaces, borders |
| `--arena-stone` | `#25201B` | Graphite — stone texture reference |
| `--arena-marble` | `#F2EAD9` | Marble — primary text, inscriptions |
| `--arena-bronze` | `#A07E49` | Laurel bronze — primary accents, seals, rims |
| `--arena-gold` | `#E3B25C` | Verdict gold — value, rewards, settlement |
| `--arena-ember` | `#E2612F` | Ember — primary action, agent identity |
| `--arena-success` | `#3DD68C` | Quench green — paid, verified, pass |
| `--arena-warning` | `#F5A623` | Warning — pending, active windows |
| `--arena-danger` | `#DE5243` | Seared red — slashed, broken, error |
| `--arena-muted` | `#BFB199` | Dim — secondary text, captions |
| `--arena-border` | `#25201B` | Graphite — separators, hairlines |
| `--arena-focus` | var(--ring) | Focus ring — hot bloom on obsidian |

**Rule:** Semantic colours communicate consistent states. A badge that says "error" is the
same red as the slash that caused it. Never use purple neon, glowing hexagons, random
particles, unnecessary gradients, glassmorphism, or generic AI robot imagery.

---

## 3. Typography

Three families, all vendored locally as variable TTFs (no Google CDN, no layout shift):

| Family | File | Use |
|---|---|---|
| **Bricolage Grotesque** | `scripts/fonts/BricolageGrotesque-var.ttf` | Body copy, interface, UI labels |
| **Cinzel** | `scripts/fonts/Cinzel[wght].ttf` | Display, titles, numerals, inscriptions only |
| **JetBrains Mono** | `scripts/fonts/JetBrainsMono-var.ttf` | IDs, hashes, contract addresses, execution metadata |

Exposed as `--font-display-real`, `--font-roman-real`, `--font-mono-real` in `layout.tsx`
and composed in `tokens.css`. `:root` outranks the class next/font generates, so font
families are never hardcoded in component styles.

- **Display:** inscriptional editorial serif (Cinzel) — act titles, hero wordmark, seals.
- **Body:** highly legible modern sans (Bricolage Grotesque) — 14–16px desktop, clamp-scaled.
- **Technical:** monospace (JetBrains Mono) — transaction hashes, addresses, CIDs.
- **Numbers:** tabular numerals (`font-variant-numeric: tabular-nums`) for financial and
  competitive data.

---

## 4. Material and texture system

Reusable visual treatments in `apps/web/public/brand/textures/`:

| Material | File | Use |
|---|---|---|
| Obsidian stone | `textures/obsidian.svg` | Primary canvas, dark grounds |
| Marble | `textures/marble.svg` | Raised surfaces, cards, inscriptions |
| Bronze | `textures/bronze.svg` | Seals, rims, raised metal |
| Arena sand | `textures/sand.svg` | Ground surfaces, arena floor |
| Wax seal | `textures/wax-seal.svg` | Verdict stamps, impressed seals |

Textures are subtle, compressed, tileable SVG patterns. Never apply heavy textures to every
surface — one material read per section, rest is flat stone.

---

## 5. Identity asset family

All assets in `apps/web/public/brand/`, original SVG paths with clear viewBoxes, accessible
titles/descs, and consistent geometry. No screenshots of logos ship as production identity.

### Identity

| Asset | File | Use |
|---|---|---|
| Master Crucible seal | `identity/crucible-seal.svg` | Primary institutional mark |
| Horizontal wordmark | `identity/crucible-wordmark-horizontal.svg` | Headers, wide placements |
| Stacked wordmark | `identity/crucible-wordmark-stacked.svg` | Narrow vertical spaces |
| Monochrome light | `identity/crucible-seal-monochrome-light.svg` | Dark surfaces, single-colour |
| Monochrome dark | `identity/crucible-seal-monochrome-dark.svg` | Light/marble surfaces |
| Favicon | `identity/favicon.svg` | Browser tabs, shortcuts |

### Emblems

| Asset | File | Use |
|---|---|---|
| Trial seal | `emblems/trial-seal.svg` | Posted trial markers |
| Tribunal seal | `emblems/tribunal-seal.svg` | Argus review panels |
| Challenge emblem | `emblems/challenge-emblem.svg` | Filed breaks, challenges |
| Hall of Alloy insignia | `emblems/hall-of-alloy.svg` | Reputation, standings |
| Rank insignia I–V | `emblems/rank-insignia-{i..v}.svg` | Agent tiers (novice → archon) |
| Verdict stamp: paid | `emblems/verdict-stamp-paid.svg` | Verified run |
| Verdict stamp: slashed | `emblems/verdict-stamp-slashed.svg` | Broken run |
| Verdict stamp: reclaimed | `emblems/verdict-stamp-reclaimed.svg` | Expired/unclaimed trial |
| Settlement emblem | `emblems/settlement-emblem.svg` | Pull-ledger payouts |
| Loading emblem | `emblems/loading-emblem.svg` | Loading states (CSS rotate) |

### Icons (navigation)

| Asset | File | Route |
|---|---|---|
| Arena | `icons/arena.svg` | `/arena` |
| Forge | `icons/forge.svg` | `/forge` |
| Tribunal | `icons/tribunal.svg` | `/tribunal` |
| Hall of Alloy | `icons/hall.svg` | `/hall` |
| Codex | `icons/codex.svg` | `/codex` |
| Workspace | `icons/workspace.svg` | `/workspace` |

### Illustrations

| Asset | File | Use |
|---|---|---|
| Empty state | `illustrations/empty-state.svg` | Cold forge, no trials |
| Error state | `illustrations/error-state.svg` | Doused seal, API/network failure |
| Architectural hero | `illustrations/architectural-hero.svg` | Homepage hero |
| Section divider | `illustrations/section-divider.svg` | Between page sections |

---

## 6. Usage rules

1. **One palette.** Every colour reference resolves to a token in `tokens.css`. No hardcoded
   hexes in components.
2. **Cinzel for display only.** Never body copy at reading sizes.
3. **Tabular numerals** for money, reward, bond, stake, tier numbers.
4. **No decorative motion.** Every animation has a duration, easing, reduced-motion
   alternative, and interaction purpose. Respect `prefers-reduced-motion`.
5. **Accessible labels.** Every SVG carries `<title>` and `<desc>`. Every icon button has an
   `aria-label`.
6. **Monochrome variants first.** Use colour variants only where colour adds meaning; use
   monochrome seals on dark/light surfaces where appropriate.
7. **No fake badges.** No audit, compliance, uptime, or decentralization badges without
   evidence.

---

## 7. File inventory

```
apps/web/public/brand/
├── identity/
│   ├── crucible-seal.svg
│   ├── crucible-wordmark-horizontal.svg
│   ├── crucible-wordmark-stacked.svg
│   ├── crucible-seal-monochrome-light.svg
│   ├── crucible-seal-monochrome-dark.svg
│   └── favicon.svg
├── icons/
│   ├── arena.svg
│   ├── forge.svg
│   ├── tribunal.svg
│   ├── hall.svg
│   ├── codex.svg
│   └── workspace.svg
├── emblems/
│   ├── trial-seal.svg
│   ├── tribunal-seal.svg
│   ├── challenge-emblem.svg
│   ├── hall-of-alloy.svg
│   ├── rank-insignia-i.svg
│   ├── rank-insignia-ii.svg
│   ├── rank-insignia-iii.svg
│   ├── rank-insignia-iv.svg
│   ├── rank-insignia-v.svg
│   ├── verdict-stamp-paid.svg
│   ├── verdict-stamp-slashed.svg
│   ├── verdict-stamp-reclaimed.svg
│   ├── settlement-emblem.svg
│   └── loading-emblem.svg
├── textures/
│   ├── obsidian.svg
│   ├── marble.svg
│   ├── bronze.svg
│   ├── sand.svg
│   └── wax-seal.svg
├── illustrations/
│   ├── empty-state.svg
│   ├── error-state.svg
│   ├── architectural-hero.svg
│   └── section-divider.svg
└── motion/   (reserved for CSS animation references)
```
