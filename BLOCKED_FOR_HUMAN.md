# Blocked-for-human items — Crucible

These items cannot be closed by code. Each requires a human decision, external party,
or funded infrastructure. Do not fabricate sign-offs, deployments, or test results.

## 1. Independent smart-contract audit (EVM + Solana)

- **Why blocked:** No code can produce an audit report. Requires a funded external auditor.
- **Action:** Engage an auditor for `crucible-contracts/contracts/*.sol` and `crucible-contracts/solana/programs/*/`. Record the report URL in `docs/mainnet/audit-signoff.json` with `signed: true` and the commit SHA.
- **Verification:** `npm run mainnet:preflight` must pass the audit check.

## 2. Legal entity, counsel, and terms of service

- **Why blocked:** Requires a real legal entity (DIFC/UAE or chosen jurisdiction), retained counsel, and signed ToS/privacy policy.
- **Action:** Complete `docs/mainnet/legal-signoff.json` fields: `entity`, `counsel`, `tosVersion`, `privacyVersion`. Set `signed: true`.
- **Verification:** Preflight checks the file exists and is signed.

## 3. Funded multisig deployer (company Safe)

- **Why blocked:** Requires creating a real Safe on mainnet with 2-of-3 (or higher) signers on hardware wallets, then funding it for gas.
- **Action:** Create the Safe, record its address in `.env` as `TREASURY_ADDRESS` (for protocol fees) and `OWNER_SAFE_ADDRESS` (for contract ownership). Verify `trials.treasury()` matches after deploy.
- **Verification:** `crucible-contracts/scripts/assert-deployment.sh` with `REQUIRE_EXPECTED_CUSTODY=1`.

## 4. Named on-call and monitoring

- **Why blocked:** Requires a real person/team with pager access and a monitoring stack (Grafana/PagerDuty/etc.).
- **Action:** Complete `docs/mainnet/monitoring.json`: `oncall`, `alertChannel`, `dashboards`. Set `signed: true`.
- **Verification:** Preflight checks the file.

## 5. Genesis sponsors and capped pilot

- **Why blocked:** Requires real companies willing to fund trials with real ETH/SOL.
- **Action:** Complete `docs/mainnet/genesis-cohort.json`: `sponsors` (non-empty list), `agents` (non-empty list), `epochCapEth` (positive). Set `signed: true`.
- **Verification:** Preflight checks non-empty lists and positive cap.

## 6. Timelock configuration

- **Why blocked:** Requires a decision on timelock duration (minimum 48h per preflight) and multisig signers.
- **Action:** Complete `docs/mainnet/timelock.json`: `multisig`, `timelockHours` (>= 48), `signers` (non-empty). Set `signed: true`.

## 7. gVisor / stronger sandbox isolation

- **Why blocked:** Requires operator decision to install gVisor (runsc) on the host and configure Docker to use it.
- **Action:** Install gVisor, set `DOCKER_RUNTIME=runsc` in `.env`, update compose to use the runtime. Test that `forge build` works under gVisor.
- **Verification:** Sandbox tests pass with `--runtime=runsc`.

## 8. Juror bench (container runtime on VPS)

- **Why blocked:** Mounting the Docker socket into the juror container grants host control. Requires an explicit operator decision.
- **Action:** Either (a) mount `/var/run/docker.sock` into the juror container and accept the risk, or (b) build a separate bench service over the compose network that the juror talks to over HTTP (no socket).
- **Verification:** Juror `/health` shows `dockerAvailable: true` and a test verification completes end-to-end on the VPS.

## 9. Showcase deployment

- **Why blocked:** Requires deploying the arena/showcase compose stack to the VPS and wiring `ARENA_ADDRESS`.
- **Action:** Run `scripts/deploy-network.mjs` with `ARENA_ADDRESS` set. Verify `/showcase` renders live data.

## 10. Persistent store for indexer (ADR-0008 reconciliation)

- **Why blocked:** ADR-0008 mandates in-memory indexer. Moving to persistent storage requires a new ADR and migration plan.
- **Action:** Write ADR-00XX justifying persistent storage, design migration, implement, test restore.
- **Verification:** Indexer survives restart with same data; reconciliation passes.

## 11. ERC-8004 fork tests

- **Why blocked:** Requires an archive-capable mainnet RPC at pinned block 24,846,426.
- **Action:** Set `MAINNET_RPC_URL` to an archive endpoint (e.g., eth.drpc.org). Run `npm run fork:test`.
- **Verification:** 4/4 fork tests pass (not skipped).

## 12. Mainnet deployment

- **Why blocked:** All of the above. Additionally requires `MAINNET_RPC_URL`, funded deployer, and `npm run mainnet:preflight` green.
- **Action:** Only after items 1-11 are complete. Run preflight, deploy, verify addresses, fund test trial, settle, withdraw.

## 13. Solana native-SOL work-escrow (CRU-008)

- **Why blocked:** The existing program uses SPL token accounts. Rewriting to native SOL requires Anchor toolchain, careful PDA design, and independent review.
- **Action:** Follow CRU-008 spec. Rewrite `work-escrow` to use System Program transfers. Build, test on localnet, verify conservation invariants.
- **Verification:** `anchor build && anchor test` pass; no SPL accounts in native-SOL path.

## 14. Commercial billing (CRU-009 through CRU-014)

- **Why blocked:** Requires approved pricing policy, payment contracts, and legal review.
- **Action:** Follow CRU-009→014 spec. Implement quote/invoice engine, EVM billing contract, Solana billing program, reconciliation, subscriptions, UX.
- **Verification:** E2E payment flows on testnet for both ETH and SOL.
