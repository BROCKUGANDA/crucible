# Operations Runbook

## Service Health Checks

- API: `curl http://localhost:8787/health`
- Funder: `curl http://localhost:8788/health`
- Database: `pg_isready`
- Redis: `redis-cli ping`

## Common Issues

### Indexer Lag
- Check: `curl http://localhost:8787/api/indexer/status`
- Fix: Restart indexer service

### Queue Backlog
- Check Redis queue length
- Scale worker instances if needed

### Database Connection Exhaustion
- Check connection pool usage
- Increase pool size or add read replicas

## Monitoring

Metrics to track:
- API request volume and latency
- Queue depth and processing time
- Indexer lag behind latest block
- Contract balance vs. ledger balance

## Escalation

1. Check service health endpoints
2. Review logs for errors
3. Check database and Redis connectivity
4. Contact on-call engineer if unresolved
