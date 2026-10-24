#!/bin/sh
# Keep the shared reverse proxy attached to this stack's compose network.
#
# The site is served by a Caddy that another project on this box owns, and it reaches
# the stack by service name — which only resolves from inside crucible_default. That
# attachment belongs to a compose file this project does not have, so a deploy of the
# OTHER project drops it, and every request for this site then answers 502 while every
# container here reports itself healthy. It happened on 2026-10-21.
#
# deploy.yml repairs the attachment at deploy time and installs this script on a host
# timer, because the break is caused by something that happens outside this project: a
# watchdog that depends on the thing it watches cannot report that the thing is broken.
#
# Idempotent, and it reads only Docker's own state.
set -u

NET=crucible_default

if ! docker network inspect "$NET" >/dev/null 2>&1; then
  echo "edge-attach: no $NET network; the stack is down - nothing to attach" >&2
  exit 0
fi

attached=0
for c in $(docker ps --format '{{.Names}}' | grep -iE 'caddy' || true); do
  attached=1
  if docker inspect -f '{{range $k,$v := .NetworkSettings.Networks}}{{$k}} {{end}}' "$c" \
    | grep -q "$NET"; then
    echo "edge-attach: $c is on $NET"
  else
    echo "edge-attach: attaching $c to $NET"
    docker network connect "$NET" "$c" || echo "edge-attach: could not attach $c" >&2
  fi
done

if [ "$attached" = "0" ]; then
  echo "edge-attach: no edge container is running on this host" >&2
fi
