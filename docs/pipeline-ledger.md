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
| push to main | ci | green |
| ci green on main | deploy | green |

Two things the ladder needed that are worth writing down:

- The job declares `permissions: contents: write` on its own token. The
  repository's workflow-permissions default is not enough for the merge push,
  and a setting a reviewer cannot see in the diff is a setting the next clone
  will not have.
- The gate is the ci run's *completion event*, not a poll of the pushed
  commit's check suites — polling deadlocks on the gate's own pending suite.

# The eight days the ladder did not run

The receipt above was true when it was written, and it stopped being true on
2026-10-12. The site kept serving an eight-day-old build and nothing about
the site said so. Three separate faults lined up, each of which alone would
have stopped the ladder and each of which hid the next.

**A wall-clock assertion in a unit test.** The indexer's backfill-cost gate
measured milliseconds and compared two sample sizes. It runs on the same box
that serves production, and on that box the fixed code measured 41.8 seconds
where a laptop measures 2.5 milliseconds; the ratio between the two sample
sizes drifted past the threshold the test allowed. The code had not changed.
The host was thrashing. The gate failed, `promote` refused a red gate, and
the ladder stopped.

The gate now counts model copies instead of milliseconds. The regression it
guards against was a per-event clone, so a copy count is the same fact
without the clock, and it holds on any machine at any load. The wall-clock
assertion that remains is a hang detector; the measurement moved to
`packages/indexer/scripts/bench-backfill.ts`, which wants a quiet machine.

**A merge conflict that could not be resolved by the job.** The same graphflow
ignore lines had been committed independently on `develop` and on `staging`,
so the two branches touched the same lines and `git merge --no-ff` refused.
One file, one conflict, and every promotion refused until a human noticed a
red pipeline.

`staging` and `main` are write-only: nothing edits them except the
promotion job, so their content is always a snapshot of some `develop` state
and never carries intent `develop` lacks. A conflicting hunk is therefore
taken from the promotion source, and everything that is not in conflict is
still merged from both sides. The promotion announces the resolution rather
than doing it silently.

**A promotion that could not ask for the next gate.** This is the one that
made the ladder unable to close on itself, and it is the reason the run
recorded above happened by hand rather than by the workflow.

A promotion pushes with `GITHUB_TOKEN`, and GitHub suppresses the `push`
event that such a push would raise, so a workflow cannot make itself loop.
The promotion wrote `staging`, nothing noticed, no gate ever ran on it, and
the promotion to `main` was never reached. The whole ladder needed a human
pushing the branches directly.

`workflow_dispatch` is the documented exception to the suppression, so the
promotion now asks for the next gate by name, and `deploy` rides the gate
rather than the push. A promotion that finds nothing to promote exits before
it dispatches anything, because otherwise the gate would complete, raise the
promotion again, and ask for the gate again — the ladder would run forever
on a branch that was already current.

# The three faults are recorded because the shape of them is the lesson

A deployment pipeline that stops for eight days does not fail loudly. It
serves yesterday's build and looks fine, because serving yesterday's build
is what it is for. The only surfaces that showed anything were a red
pipeline nobody was watching and a site that looked the same as it had all
week.

What the faults have in common is that each of them was a *measurement* or a
*mechanism* that assumed a quiet, ideal world: a timer that assumed a
loaded machine still ticks at the speed of a laptop, a merge that assumed
the branches had not been edited from two directions, and a push that
assumed the next stage was listening.

The fixes are the same shape. A copy count instead of a clock. A rule about
which side wins instead of a hope that they agree. An explicit request for
the next gate instead of an assumption that it will be raised.
