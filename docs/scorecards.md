# Evaluation scorecards

The public scorecard pipeline publishes off-chain evaluation results without giving the API a
signing key or a write path. The evaluator writes immutable bytes and a signed publication receipt
to the same persistent `content` volume that the API reads read-only.

## Publication

Run the grader with a reviewed, non-stub provider and `--publish`. The publication needs a cohort,
registered agent id, current runner address and chain id. Set `CRUCIBLE_SCORECARD_SIGNER_KEY` in the
grader's secret environment; do not put it in the API environment or command line. The API's
`CRUCIBLE_SCORECARD_SIGNERS` is a comma-separated allowlist of those off-chain attestor addresses.

```bash
npm run arena:grade -- \
  --provider openai-compat \
  --card grader/model-cards/your-reviewed-card.json \
  --publish --cohort pilot-2026 --agent-id 7 \
  --runner 0x0000000000000000000000000000000000000007 --chain-id 31337
```

Set `CRUCIBLE_CONTENT_DIR` in the grader to the persistent volume mounted at `/content` for the API.
By default the evaluator stores blobs in `<content-dir>/scorecards/store` and publication receipts
in `<content-dir>/scorecards/publications`. `CRUCIBLE_SCORECARD_PUBLICATIONS_DIR` can override the
receipt directory when the API is configured with the same path. The dedicated scorecard store does
not evict published bytes; a failed or full-disk write stops publication. The evaluator reads each
blob back before it signs or writes the receipt.

The scorecard bytes include the cohort, chain id, agent id, runner, issue time and attestor address.
The detached EIP-712 receipt signs those values plus the scorecard CID and digest. Its stable replay
key is derived from cohort, chain, agent, runner and scorecard digest, so retrying the same receipt
is idempotent and trying to republish the same result with a new issue time conflicts.

## Verification and reading

`GET /scorecards` returns only verified publications. It supports `cohort` and `agentId` query
filters; `GET /scorecards/:id` reads one publication. `GET /scorecards/content/:cid` serves the
durable scorecard, corpus or trajectory bytes. The API checks the signer allowlist and EIP-712
signature, the configured chain id, the registered agent's current runner, the scorecard content
digest, every row's manifest digest, the cohort and identity recorded in the scorecard, and each
corpus and trajectory evidence reference. Any failed check rejects the response instead of
presenting a partial list.

The `/scorecards` web page lists verified results and filters by cohort and agent. The page links to
the exact stored scorecard, corpus and trajectory evidence. If a signer, content source or chain
identity is not configured or cannot be checked, the API returns an unavailable or verification
error and the UI does not render a zero score.

## Release boundary

This read path does not accept ETH and does not change the escrow contracts. It does not authorize
real-money traffic or satisfy the production release sequence. Keep real-money traffic closed until
every release gate in `docs/crucible-deploy-day-gates.md` and the promotion ladder has passed. CRU-003
remains untouched until this pipeline's end-to-end integration is accepted.
