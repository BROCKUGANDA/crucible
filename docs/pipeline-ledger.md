---
# The ladder, end to end, proven

The promotion path is not documentation here, it is a run that happened: a
commit lands on develop, ci proves it, `promote` merges it to staging, ci
proves that, `promote` merges it to main, and `deploy` ships it. This file is
that run's receipt.

| Step | What ran | Result |
|---|---|---|
| push to develop | ci | green |
| ci green on develop | promote → merge into staging | green |
| push to staging | ci | green |
| ci green on staging | promote → merge into main | green |
| push to main | deploy | green |

Two things the ladder needed that are worth writing down:

- The job declares `permissions: contents: write` on its own token. The
  repository's workflow-permissions default is not enough for the merge push,
  and a setting a reviewer cannot see in the diff is a setting the next clone
  will not have.
- The gate is the ci run's *completion event*, not a poll of the pushed
  commit's check suites — polling deadlocks on the gate's own pending suite.
