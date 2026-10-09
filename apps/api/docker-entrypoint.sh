#!/bin/sh
# The seed container publishes what actually got deployed (Demo.s.sol owns its own
# deployments); prefer it over the static environment so the API always reads the
# chain it is actually connected to.
set -eu

if [ -f /run/crucible/deployed.env ]; then
  . /run/crucible/deployed.env
fi

cd "$(dirname "$0")" 2>/dev/null || true
cd /repo/apps/api
exec node dist/server.js
