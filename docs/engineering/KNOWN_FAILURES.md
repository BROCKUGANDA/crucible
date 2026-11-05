# Crucible — Known Failures and Blocked Items

**Date:** 2026-11-05  
**Branch:** `develop`

## Blocked-for-human items (cannot be closed by code)

These are recorded in `BLOCKED_FOR_HUMAN.md` items 1–14. Each requires a human decision, external party, or funded infrastructure.

| # | Item | Why blocked | Unblock condition |
|---|---|---|---|
| 1 | Independent smart-contract audit (EVM + Solana) | Requires funded external auditor | Audit report URL recorded in `docs/mainnet/audit-signoff.json` with `signed: true` + commit SHA |
| 2 | Legal entity, counsel, ToS | Requires real legal entity + retained counsel | `docs/mainnet/legal-signoff.json` fields completed, `signed: true` |
| 3 | Funded multisig deployer (company Safe) | Requires real Safe on mainnet, 2-of-3+ signers on hardware wallets, funded for gas | `TREASURY_ADDRESS` + `OWNER_SAFE_ADDRESS` in `.env`; `trials.treasury()` matches after deploy |
| 4 | Named on-call + monitoring | Requires real person/team with pager access + Grafana/PagerDuty | `docs/mainnet/monitoring.json` completed, `signed: true` |
| 5 | Genesis sponsors + capped pilot | Requires real companies funding trials with real ETH/SOL | `docs/mainnet/genesis-cohort.json`: non-empty sponsors/agents, positive `epochCapEth`, `signed: true` |
| 6 | Timelock configuration | Requires decision on duration (>=48h) + multisig signers | `docs/mainnet/timelock.json`: multisig, `timelockHours` >= 48, non-empty signers, `signed: true` |
| 7 | gVisor / stronger sandbox isolation | Requires operator decision to install gVisor (runsc) + configure Docker | `DOCKER_RUNTIME=runsc` in `.env`; compose updated; `forge build` works under gVisor |
| 8 | Juror bench (container runtime on VPS) | Mounting Docker socket grants host control | Explicit operator decision: (a) mount socket + accept risk, or (b) separate bench service over HTTP |
| 9 | Showcase deployment | Requires deploying arena/showcase compose to VPS + wiring `ARENA_ADDRESS` | `scripts/deploy-network.mjs` with `ARENA_ADDRESS` set; `/showcase` renders live data |
| 10 | Persistent store for indexer | ADR-0008 mandates in-memory; migration needs new ADR | New ADR-00XX justifying persistent storage + migration plan + restore test |
| 11 | ERC-8004 fork tests | Requires archive-capable mainnet RPC at pinned block 24,846,426 | `MAINNET_RPC_URL` set to archive endpoint; 4/4 fork tests pass (not skipped) |
| 12 | Mainnet deployment | All of the above + `MAINNET_RPC_URL`, funded deployer, preflight green | Items 1–11 complete; `npm run mainnet:preflight` green; deploy + verify + settle + withdraw |
| 13 | Solana native-SOL work-escrow (CRU-008) | Existing program uses SPL token accounts; needs Anchor toolchain, PDA design, independent review | `anchor build && anchor test` pass; no SPL accounts in native-SOL path; conservation invariants verified |
| 14 | Commercial billing (CRU-009→014) | Requires approved pricing policy, payment contracts, legal review | Quote/invoice engine, EVM billing contract, Solana billing program, reconciliation, subscriptions, UX — all E2E on testnet for ETH and SOL |

## Build-blocked items

| Item | Blocker | Workaround / status |
|---|---|---|
| Solana SBF build (`anchor build`) | No reachable `cargo-build-sbf 3.0.0` from this network; agave org does not resolve | Toolchain pinned at solana-labs v1.18.26 + anchor-cli 0.30.1 (scripts/toolchain-pin.sh); build finishes elsewhere |
| `npm ci` lockfile | Missing `@crucible/arena-events` and `@crucible/fork-host` (pre-existing, not caused by any current branch) | Noted in PR #63 CI block; lockfile not changed by current work |
| `next dev` rewrites tsconfig | Rewrites `apps/web/tsconfig.json` to `"jsx": "preserve"` and `next-env.d.ts` | Revert both before committing |
| `format:check` red on Windows | CRLF working tree vs LF blobs (`.gitattributes` pins eol=lf only for fixtures) | Not a CI gate; never run `prettier --write` across the tree |

## Known measurement traps (from AGENTS.md)
| Trap | Lesson |
|---|---|
| Re-running a red money gate to get green | Never. `invariant_balanceConservation` failure = correct promotion refusal. |
| Asserting `Math.random()` output | Failed 1 run in 65; now pins the draw and checks the doubling schedule. |
| Timeout/cancel test asserting caller stopped waiting | Must assert end state (container gone, row absent). |
| Wiring check reading file prose not command | Filter comment lines; match the executed statement. |
| "Package named in src file" != imported | Assert which file imports it. |
| Non-reproducing red as noise | Treat as open, not noise, however many rolls pass. |

## No production claim without evidence
- `https://crucible.svalley.tech` is a demonstration on a local development chain behind Cloudflare Zero Trust; contracts unaudited; no real-value funds.
- v2 Arena has no public-chain deployment or product UI.
- Native Solana is not shipped; work-escrow source exists but is not a production SOL rail.
- The website's live deployment is not evidence of production readiness.