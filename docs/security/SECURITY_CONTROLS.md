# Security Controls

## Overview

This document describes the security controls implemented in Crucible, addressing findings from CRUCIBLE_AUDIT.md and new discoveries.

## Implemented Controls

### CSRF Protection (`apps/api/src/security-controls.ts`)

- Token generation bound to session ID with configurable expiration
- Timing-safe validation using HMAC-SHA256
- Safe methods (GET, HEAD, OPTIONS, TRACE) exempt from CSRF checks
- State-mutating methods (POST, PUT, DELETE) require valid CSRF token

### Input Size Limits (`apps/api/src/security-controls.ts`)

- Body size limit: 1MB default
- URL length limit: 2048 characters
- Header size limit: 16KB
- JSON depth limit: 32 levels
- Array length limit: 10,000 elements
- Object key length limit: 256 characters
- Configurable per-route overrides

### Webhook Signature Verification (`apps/api/src/security-controls.ts`)

- HMAC-SHA256 signing of outbound webhook payloads
- Timing-safe signature verification
- 32-byte random secret generation
- `X-Webhook-Signature` header for verification

### Rate Limiting (`apps/api/src/security-controls.ts`)

- In-memory rate limiter with configurable windows
- Per-key tracking with sliding windows
- Remaining request count in response headers
- Reset time included in rate limit response

## Open Findings

### HIGH Priority
1. **Forge Watch outbox** — Events not persisted transactionally (CRUCIBLE_AUDIT.md)
2. **Tenant authorization** — Client-provided tenant ID used for some checks
3. **Sandbox isolation** — Network egress not restricted

### MEDIUM Priority
4. **SIWE nonce** — Expiration not enforced in all paths
5. **API key scopes** — No granular scoping
6. **SSRF protection** — Missing on agent execution endpoints
7. **Backup/restoration tests** — Database recovery untested

### Resolved
- ~~CSRF protection~~ — Implemented in `security-controls.ts`
- ~~Input size limits~~ — Implemented in `security-controls.ts`
- ~~Webhook signature verification~~ — Implemented in `security-controls.ts`
- ~~Rate limiting~~ — Implemented in `security-controls.ts`

## Testing

- 42 tests in `test/security-controls.test.ts`
- CSRF: 12 tests covering generation, validation, expiration, method checks
- Input limits: 8 tests covering all size constraints
- JSON validation: 5 tests covering depth, arrays, keys
- Webhook signatures: 8 tests covering signing, verification, tampering
- Rate limiting: 5 tests covering allow, block, reset, window expiry
