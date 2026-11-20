# Support Runbook

## Support Tiers

- **Tier 1:** API documentation, status page, FAQ
- **Tier 2:** Engineering triage, bug reports
- **Tier 3:** Critical incidents, security issues

## Common Issues

### API Errors
- Check status page: `/health`
- Review error codes in API documentation
- Check rate limit headers

### Evaluation Failures
- Check worker logs
- Verify sandbox resources
- Review artifact integrity

### Authentication Issues
- Verify SIWE nonce expiration
- Check session validity
- Review API key scopes

## Incident Response

1. Assess severity
2. Notify on-call engineer
3. Document incident
4. Communicate with affected users
5. Post-mortem within 48 hours
