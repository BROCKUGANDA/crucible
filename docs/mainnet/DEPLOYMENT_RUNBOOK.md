# Deployment Runbook

## Pre-Deployment Checklist

1. All tests pass: `npm run verify:all`
2. Foundry tests pass: `cd crucible-contracts && node ../scripts/run-forge.mjs test`
3. Forge build compiles: `node ../scripts/run-forge.mjs build --sizes`
4. CHAIN_ENV set correctly (anvil/testnet/mainnet)
5. All required environment variables configured
6. Database migrations reviewed and tested
7. Contract addresses verified for target chain

## Deployment Steps

### 1. Build Images
```bash
docker compose build
```

### 2. Run Migrations
```bash
docker compose run --rm api npx prisma migrate deploy
```

### 3. Start Services
```bash
docker compose up -d
```

### 4. Verify Health
```bash
# Check each service health endpoint
curl http://localhost:8787/health
curl http://localhost:8788/health
```

### 5. Verify Chain Connection
```bash
# Check indexer is syncing
curl http://localhost:8787/api/indexer/status
```

## Rollback Procedure

1. Stop current deployment: `docker compose down`
2. Revert to previous image tag
3. Run database rollback if needed: `npx prisma migrate reset`
4. Restart: `docker compose up -d`

## Environment Variables

See `compose.yaml` for all required environment variables. Critical variables:
- `CHAIN_ENV` — Must be explicitly set
- `CHAIN_ID` — Must match target chain
- `RPC_URL` — Primary RPC endpoint
- `DATABASE_URL` — PostgreSQL connection string
- `REDIS_URL` — Redis connection string
