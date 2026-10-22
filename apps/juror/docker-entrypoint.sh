#!/bin/sh
# Pin the trial content, then serve.
#
# Order is the whole point. A trial's spec and suite are keccak digests on the chain, and a seat
# that cannot fetch the bytes behind them abstains — which is the honest answer to "no evidence" and
# also a demo in which nothing ever gets verified. So the store is filled from the fixtures baked
# into this image before the first pass, and `--check` is what proves the digests the contracts were
# compiled with are the digests these bytes produce. If those two ever disagree, the seat refuses to
# start rather than abstaining quietly forever: a commitment that resolves to nothing is a lie the
# chain tells about content, and it is not a thing to discover from a log line months later.
#
# No `|| true`, no fallback, no "keep going without a store". A seat running against an empty store
# looks healthy and votes on nothing.
set -eu

export CRUCIBLE_CONTENT_DIR="${CRUCIBLE_CONTENT_DIR:-/content}"

echo "[juror] pinning the trial content into ${CRUCIBLE_CONTENT_DIR}"
node --env-file-if-exists=.env scripts/seed-content.mjs --check

exec "$@"
