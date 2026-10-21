#!/bin/sh
# Keep the shared edge attached to this stack.
#
# The site is served by a reverse proxy another project on the same box owns.
# It reaches this stack by service name, which only works from inside this
# stack's compose network, and that attachment is made by hand — it belongs to
# a compose file this project does not have. A recreate of the proxy drops
# it, and the symptom is that every request for this site answers 502 while
# every container in this stack reports itself healthy.
#
# This runs on the HOST, on a timer, for two reasons:
#
#   * it must not depend on a CI runner being free. The runners are busy, and
#     a schedule that waits for one is a schedule that arrives late — which is
#     the same as no schedule at all when the thing it repairs takes minutes
#     to notice.
#   * it must not depend on the deploy pipeline. The attachment is dropped by
#     a deploy of a different project; nothing about this project happens at
#     that moment, so nothing about this project would notice.
#
# Idempotent, read-mostly, and safe to run every minute: it only acts when the
# attachment is actually missing.
set -eu

NET=$(docker network ls --format '{{.Name}}' 2>/dev/null | grep -E '^crucible_default$' | head -n 1 || true)
if [ -z "$NET" ]; then
  echo "$(date -Is) the crucible network is missing; nothing to attach to"
  exit 0
fi

for c in $(docker ps --format '{{.Names}}' 2>/dev/null | grep -iE 'caddy' || true); do
  if docker inspect -f '{{range $k,$v := .NetworkSettings.Networks}}{{$k}} {{end}}' "$c" 2>/dev/null | grep -q "$NET"; then
    continue
  fi
  if docker network connect "$NET" "$c" 2>/dev/null; then
    echo "$(date -Is) attached $c to $NET"
  else
    echo "$(date -Is) could not attach $c to $NET"
  fi
done
