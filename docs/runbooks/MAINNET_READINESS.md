# Mainnet Readiness Runbook

**Status:** not ready (all gates unknown by default)  
**Evaluator:** `apps/api/src/mainnet-readiness.ts` → `evaluateMainnetReadiness`

## Rule

Production financial operations remain disabled unless every required gate is
verified (true). A gate that is false or unknown (null/undefined) keeps mainnet
disabled. Unknown is treated as not-ready — never as a pass.

## Required gates

1. chainIdCorrect
2. deploymentManifestSigned
3. contractAddressesVerified
4. contractBytecodeVerified
5. independentAuditSignOff
6. treasurySafeConfigured
7. hardwareSignersPresent
8. governanceTimelock
9. durableDatabase
10. objectStorageDurable
11. backupRestoreDrill
12. monitoringAndOnCall
13. sponsorshipLimits
14. emergencyPauseControls
15. legalAndOperationalApproval
16. mainnetPreflightTests

## Owner actions required

- Provision Alchemy apps + keys (demo/preview/production).
- Configure Treasury Safe + hardware signers.
- Obtain independent audit sign-off.
- Complete legal and operational approval.
- Run mainnet preflight tests against real deployments.
- Run backup/restore drills; document evidence.

## Evidence rule

Every gate must reference commit SHA + environment-specific test results.
No fabricated deployment records. Do not create records to satisfy a check.
