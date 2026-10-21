---
# What shipped after the submission

Colosseum judges the work done during the hackathon window. Everything in
this file is **after** that window, and the exact submitted commit is tagged
`cwf-submission` so a judge can diff the two directly:

```bash
git diff cwf-submission..HEAD --stat
```

The tag points at `dd52c07` — the last commit on the branch while the window
was open (2026-10-12). Nothing after it is presented as in-window work.

| Date | Shipped | Where to see it |
|---|---|---|
| 2026-10-12 | Cursor persistence in the indexer, so a restart does not re-scan the chain from the beginning | `packages/indexer/src/scribe.ts` |
| 2026-10-21 | The backfill-cost gate stopped asserting wall-clock. It ran on the host that also serves production, where the fixed code measured 41.8 seconds against a laptop's 2.5 milliseconds, so a thrashing box failed a gate about code that had not changed | `packages/indexer/test/model.test.ts` |
| 2026-10-21 | The promotion ladder ran again. A merge conflict could not be resolved by the job, and a promotion could not ask for the next gate — so the ladder had been stopped for eight days, and production kept serving an eight-day-old build | `.github/workflows/promote.yml`, `docs/pipeline-ledger.md` |
| 2026-10-21 | The shared edge was reattached to this stack. It is a proxy another project on the same box owns, and a recreate of it dropped the attachment, so every request answered 502 while every container here reported itself healthy | `.github/workflows/edge.yml`, `docs/setup.md` |
| 2026-10-21 | The live feed stopped spending the read budget. A stream is one request that holds a socket open, and charging it against a per-minute budget meant a few idle tabs exhausted it and the reads that mattered started answering 429 | `apps/api/src/app.ts`, `apps/web/src/lib/useSnapshot.ts` |
| 2026-10-21 | Every route serves one snapshot. They each built their own, and the stream carried the settlement fee while `/snapshot` did not, so a refresh and a live update described the same chain differently | `apps/api/src/app.ts` |
| 2026-10-21 | The platform publishes its books: the volume, the fee and the payout, with the fee read from the contract rather than copied into the process | `packages/indexer/src/api.ts`, `apps/web/src/app/docs/page.tsx` |
| 2026-10-21 | The demo has a trial a visitor can claim, and one waiting for a run. It was four settled trials — a hall worth reading and nothing to do | `crucible-contracts/script/Extend.s.sol` |
| 2026-10-21 | The secret gate: the whole git history is scanned for leaked keys, and every suppression states what the value is and why it is not a secret | `.github/workflows/ci.yml`, `.gitleaks.toml` |
| 2026-10-21 | The indexer stopped freezing on a quiet gap, stopped advancing past a truncated response, and rebuilds after a chain reset | `packages/indexer/src/scribe.ts` |
| 2026-10-21 | The sign-in stopped taking its origin from a request header, and a challenge is now bound to the browser that asked for it | `apps/api/src/auth.ts` |
| 2026-10-21 | The rate limiter stopped reading the forwarded hop a caller writes, and stopped putting every visitor behind the proxy in one bucket | `apps/api/src/rate-limit.ts` |
| 2026-10-21 | The read model stopped moving a trial backwards, and stopped losing a verdict for a trial the index had not seen | `packages/indexer/src/model.ts` |
| 2026-10-21 | The deployment proves itself: a post-deploy assertion reads the live chain and fails the deploy if the fee, the bond rule, the committee, the roles or the money invariant are not what the documentation claims | `crucible-contracts/scripts/assert-deployment.sh` |
| 2026-10-21 | Every key this project uses, and every power an address holds, written down — with what a compromise reaches and what changes on a real chain | `docs/key-inventory.md` |
| 2026-10-21 | The escrow contract rejects empty spec/test CIDs, zero runner keys, zero run hashes and zero break proofs, and caps a single reward and total escrow | `crucible-contracts/contracts/CrucibleTrials.sol`, `crucible-contracts/test/CrucibleTrials.t.sol` |
| 2026-10-21 | The API answers the Kubernetes-style `/healthz` and `/readyz` aliases with the same readiness contract as `/health` and `/ready` | `apps/api/src/app.ts`, `apps/api/test/app.test.ts` |
| 2026-10-21 | `npm test` finds Foundry even when it is installed outside PATH, and `npm run verify:all` is the one command that runs typecheck plus every suite | `scripts/run-forge.mjs`, `crucible-contracts/package.json`, `package.json` |
| 2026-10-21 | A machine-readable security contact is published at `/.well-known/security.txt` | `apps/web/src/app/.well-known/security.txt/route.ts` |

## The shape of the outage

The pipeline stopped for eight days without saying so. The site kept serving
yesterday's build, and yesterday's build looked exactly like today's.

Each of the faults was a **measurement or a mechanism that assumed a quiet,
ideal world**: a timer that assumed a loaded machine still ticks at the speed
of a laptop; a merge that assumed the branches had not been edited from two
directions; a push that assumed the next stage was listening; a watchdog that
ran on the deploy pipeline and so could not notice a deploy on another
pipeline; a limiter that counted its own long-lived connections as a request
flood; a challenge that could be completed by any browser that learned a
nonce.

The fixes are the same shape. A copy count instead of a clock. A rule about
which side wins instead of a hope that they agree. An explicit request for
the next gate. A cron entry on the box that runs whether or not this
repository is touched.
