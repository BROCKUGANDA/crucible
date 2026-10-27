#!/bin/sh
# The seed publishes what actually got deployed (Demo.s.sol owns its own deployments);
# prefer it over the static environment so the keeper sweeps the chain it is connected to.
#
# Same file and same precedence as apps/api/docker-entrypoint.sh. The keeper used to read
# only `.env`, which is a second answer to "where are the contracts" — and after a re-seed
# the two disagree in the one direction that keeps running: the API follows the file, the
# keeper keeps sweeping the address the template baked in.
set -eu

if [ -f /run/crucible/deployed.env ]; then
  # Export on the way in, or the file only reassigns variables `.env` already exported and an
  # address published by the seed that `.env` never names never reaches this process. See the same
  # three lines in apps/api/docker-entrypoint.sh.
  set -a
  . /run/crucible/deployed.env
  set +a
fi

exec node apps/keeper/dist/main.js
