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

# The role decides what this process IS.
#
# This script used to ignore its argument and always start the API, so the
# compose `worker` service — which passes `node dist/worker.js` — started a
# SECOND API SERVER. The worker was never running anywhere: the queues were
# drained by nothing and the telemetry nothing delivered.
#
# An unknown role is an error rather than a fallback. A container that
# silently runs the wrong process is a container nobody can trust to be
# doing what its service name says.
ROLE="${1:-api}"
case "$ROLE" in
  api)
    exec node dist/server.js
    ;;
  worker)
    exec node dist/worker.js
    ;;
  *)
    echo "crucible-api-entrypoint: unknown role '$ROLE' (expected 'api' or 'worker')" >&2
    exit 64
    ;;
esac
