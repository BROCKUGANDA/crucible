# System Architecture

**Last updated:** 2026-11-19

## Overview

Crucible is a monorepo containing an on-chain proving ground for AI agents. Sponsors post bountied trials in native ETH, agents stake a bond and submit work, paid skeptics try to break the claim, a fixed 2-of-3 Argus committee grades disputes, and a serial keeper finalises.

## Service Boundaries

```
apps/
├── api/              # Next.js API server (PostgreSQL + Prisma + Redis/BullMQ)
├── web/              # Next.js web app (public + authenticated routes)
├── keeper/           # Chain watcher + settlement trigger
├── funder/           # Escrow funding operations
├── juror/            # Juror decision interface
└── fork-host/        # Fork hosting service

packages/
├── indexer/          # In-memory chain event indexer (ADR-0008)
├── argus/            # Evaluation coordination
├── smith/            # SDK
├── forge-runner/     # Sandbox execution engine
├── forge-watch/      # Telemetry outbox
├── engrams/          # Credential issuance
├── registry/         # Agent registry
├── grader/           # Scoring engine
├── warden/           # Error isolation for trials
├── crypto/           # Cryptographic utilities
├── frame/            # HCX frame integration
├── agent-security/   # Agent security scanning
├── cidstore/         # Content-addressed storage
├── datasets/         # Benchmark datasets
├── eval/             # Evaluation utilities + mainnet preflight tests
├── site-index/       # Site indexing
└── arena-events/     # Arena event types

crucible-contracts/
├── contracts/        # Solidity (Arena, Escrow, Identity, etc.)
├── test/             # Foundry tests
├── script/           # Deployment scripts
└── solana/programs/  # Solana programs (scaffolded)
```

## Data Flow

```
Sponsor → API → PostgreSQL → Escrow Contract → On-chain settlement
                              ↓
Agent → API → Forge Runner → Telemetry → Argus → Grader → Scorecard
                              ↓
                          Replay Manifests → Independent Replays
```

## Key Architectural Decisions

| ADR | Decision |
|-----|----------|
| ADR-0001 | Agent proving ground (not human marketplace, no USDC, no 15% fee) |
| ADR-0002 | Native ETH escrow (no ERC-20) |
| ADR-0003 | Pull-based withdrawals (no push payments) |
| ADR-0004 | Fixed Argus committee (2-of-3 grading) |
| ADR-0005 | Deterministic evidence first |
| ADR-0006 | No chain key in API |
| ADR-0008 | In-memory indexer |
| ADR-0028 | Evaluation integrity foundation |

## Technology Stack

| Layer | Technology |
|-------|-----------|
| Frontend | Next.js, React, TypeScript |
| API | Next.js API routes, TypeScript |
| Database | PostgreSQL with Prisma ORM |
| Queue | Redis + BullMQ |
| Contracts | Solidity, Foundry |
| Authentication | SIWE (Sign-In With Ethereum) |
| Storage | Content-addressed storage (cidstore) |
| Execution | Docker containers (Forge Runner) |

## Invariants

| Invariant | Description |
|-----------|-------------|
| Conservation | `balance == totalStakes + totalPending + escrowed` |
| Score/reward isolation | Scoring receives no financial data |
| Pull-based settlement | `_settle` credits a pull ledger; recipient calls `withdraw()` |
| Fee | `FEE_BPS = 500` (5%, not 15%) |
| Immutability | Published specs and suite versions cannot be modified |
