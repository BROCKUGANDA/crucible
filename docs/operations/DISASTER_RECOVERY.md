# Disaster Recovery

## Backup Strategy

- **PostgreSQL:** Daily pg_dump with WAL archiving
- **Redis:** RDB snapshots every hour
- **Artifacts:** Object storage with versioning

## Recovery Procedures

### Database Recovery
1. Stop all services
2. Restore from latest backup
3. Replay WAL logs if available
4. Verify data integrity
5. Restart services

### Indexer Recovery
1. Reset indexer state
2. Re-index from last known good block
3. Verify event count matches on-chain

### Full System Recovery
1. Restore database
2. Restore Redis
3. Deploy latest verified image
4. Run reconciliation checks
5. Verify all health endpoints

## Testing

- Monthly backup restoration tests
- Quarterly full DR drills
- Document recovery time objectives
