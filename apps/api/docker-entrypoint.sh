#!/bin/sh
# The seed container publishes what actually got deployed (Demo.s.sol owns its own
# deployments); prefer it over the static environment so the API always reads the
# chain it is actually connected to.
set -eu

if [ -f /run/crucible/deployed.env ]; then
  # `set -a` is the whole point. Without it, sourcing only updates variables the environment
  # already exported — so an address the seed publishes that `.env` never named simply never
  # reaches this process, and the API reports "no such contract on this host" about a contract the
  # seed deployed seconds ago. Measured while wiring TeamLedger: TRIALS/ALLOY happened to work
  # because `.env` already exported them, which is why the bug stayed invisible.
  set -a
  . /run/crucible/deployed.env
  set +a
fi

cd "$(dirname "$0")" 2>/dev/null || true
cd /repo/apps/api
exec node dist/server.js
