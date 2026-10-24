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
  . /run/crucible/deployed.env
fi

exec node apps/keeper/dist/main.js
