# Chain Architecture

**Last updated:** 2026-11-19

## Overview

Crucible uses a local Anvil chain (id 31337) for development and testing. Mainnet deployment requires explicit `CHAIN_ENV` configuration, VRF integration, treasury controls, and multisig governance.

## Current Chain Configuration

| Parameter | Value |
|-----------|-------|
| Chain | Anvil (local) |
| Chain ID | 31337 |
| Network | Local development |
| VRF | Mode 0 (deterministic, demo only) |
| RPC | Local Anvil node |

## Target Mainnet Configuration

| Parameter | Requirement |
|-----------|-------------|
| CHAIN_ENV | Explicit configuration, fail on missing |
| Chain ID | Production chain ID |
| RPC | Primary + fallback RPC endpoints |
| VRF | Chainlink VRF v2.5 (Mode 1) |
| Treasury | Multisig wallet |
| Finality | Production finality policy |

## Chain Environment Isolation

```typescript
interface ChainConfig {
  APP_ENV: string;        // development, staging, production
  CHAIN_ENV: string;      // anvil, testnet, mainnet
  chainId: number;
  rpcUrl: string;
  rpcFallbackUrl: string;
  explorerUrl: string;
  contractManifest: ContractAddresses;
  treasuryAddress: string;
  vrfConfig: VRFConfig;
  confirmationPolicy: number;
  finalityPolicy: string;
}
```

Missing configuration must stop startup. Never silently fall back from mainnet to a local chain.

## Contracts

| Contract | Purpose | Status |
|----------|---------|--------|
| Arena | Trial execution and settlement | Working (Anvil) |
| Escrow | Native ETH escrow | Working (Anvil) |
| Identity | Seven-state agent identity | Working (Anvil) |
| Grader | Scoring and verification | Scaffolded |

## Conservation Invariant

```
balance == totalStakes + totalPending + escrowed
```

Every ETH-moving path must maintain this invariant. Tested in `test/Invariants.t.sol:170`.

## VRF Integration

| Mode | Description | Status |
|------|-------------|--------|
| Mode 0 | Deterministic randomness | Demo only, blocks mainnet |
| Mode 1 | Chainlink VRF v2.5 | Required for mainnet |

Mode 0 must never be accepted for a real-money Arena. Mode 1 must be fully implemented and verified before a funded trial can use it.

## Treasury and Key Management

| Role | Requirement |
|------|-------------|
| Treasury ownership | Multisig wallet |
| Deployment authority | Separate from treasury |
| Contract administration | Separate from deployment |
| Keeper permissions | Least privilege |
| Funder permissions | Least privilege |
| Emergency pause | Independent authority |

## Settlement Flow

1. Trial completes
2. Keeper triggers settlement
3. `_settle` credits pull ledger (no push payments)
4. Recipient calls `withdraw()` in separate transaction
5. Conservation invariant verified

## Indexer

- In-memory indexer (ADR-0008)
- No database for chain events
- Reconciliation service required for mainnet

## Mainnet Release Gates

| Gate | Requirement |
|------|-------------|
| Gate F | VRF integrated, no deterministic fallback |
| Gate G | Production RPC with fallback |
| Gate H | Contract deployment with multisig |
| Gate J | Mainnet preflight all gates green |
