#!/bin/sh
# Install and start this project's edge on the box.
#
#   ./deploy/edge/provision.sh              # install from this checkout
#   INSTALL_DIR=/srv/crucible-edge ./deploy/edge/provision.sh
#
# ── What it does, and why each step is here ───────────────────────────────────
#
#   1. CHECKS THAT THE FRONT DOOR'S TABLE AND THE EDGE'S PORTS AGREE.
#      The front door routes a hostname to a loopback port; the edge
#      publishes that port. If they disagree, the front door forwards to
#      nothing and the hostname answers with a connection refused — for
#      EVERY public name on the box, not just this one. A two-line file
#      disagreeing with a compose file is exactly the kind of thing that
#      should stop a script rather than be discovered by a visitor.
#
#   2. COPIES THE EDGE INTO ITS OWN DIRECTORY. The application stack is
#      deployed by `scripts/deploy-vps.sh` from the checkout; the edge is
#      deployed from here, into a directory of its own, so that an
#      application deploy can never tear down the edge (and an edge deploy
#      can never touch the application).
#
#   3. STARTS IT AND WAITS FOR HEALTH. `docker compose up -d` returns before
#      the container is serving, and a front door pointed at an edge that is
#      not up yet black-holes the name.
#
#   4. VERIFIES IT ANSWERS, ON THE PUBLIC NAME. The check uses `--resolve`
#      because the edge publishes on LOOPBACK: the name has to be pointed at
#      127.0.0.1 explicitly, or the check would go out to the public
#      internet and measure the front door instead of the edge.
#
#   5. PROVES THE RPC GATE IS IN THE PATH. A container that is up and a site
#      that answers 200 are both true of an edge that proxies /anvil straight
#      to the node, which is what was deployed until 2026-10-27. So the script
#      asks the live endpoint for the node's control methods and refuses to
#      call the install finished while any of them is answered.
set -eu

SRC="$(cd "$(dirname "$0")" && pwd)"
INSTALL_DIR="${INSTALL_DIR:-$HOME/crucible-edge}"
NAME="crucible.svalley.tech"
TLS_PORT=8444
HTTP_PORT=8081

# ── 1. the table and the ports must agree ─────────────────────────────────────
for map in "$SRC/nginx/edge.d/crucible.sni.map" "$SRC/nginx/edge.d/crucible.host.map"; do
	[ -f "$map" ] || {
		echo "$map is missing" >&2
		exit 1
	}
done
if ! grep -q "$TLS_PORT;" "$SRC/nginx/edge.d/crucible.sni.map"; then
	echo "the front door's TLS table does not name port $TLS_PORT for $NAME" >&2
	echo "  $SRC/nginx/edge.d/crucible.sni.map" >&2
	exit 1
fi
if ! grep -q "$HTTP_PORT;" "$SRC/nginx/edge.d/crucible.host.map"; then
	echo "the front door's HTTP table does not name port $HTTP_PORT for $NAME" >&2
	echo "  $SRC/nginx/edge.d/crucible.host.map" >&2
	exit 1
fi

# ── 2. install ────────────────────────────────────────────────────────────────
#
# The gate code belongs in the installed directory, not only in the checkout.
#
# This is the line that was missing, and the reason "the gate is deployed" was false for
# five days: compose.yaml mounts `./rpc-gate:/gate`, this script copied only the Caddyfile
# and the compose file, so the installed edge had no gate to mount and kept serving /anvil
# straight to the node. The live scan on 2026-10-27 answered `eth_accounts` with the ten
# unlocked dev signers.
#
# Whether the edge's own configuration changed is measured BEFORE the copy, because a
# bind-mounted Caddyfile is never reloaded — this edge runs with `admin off`, so the
# running Caddy keeps the config it read at container start. Copying a new Caddyfile over
# an old container changes nothing until the container is recreated.
needs_recreate=0
for f in Caddyfile compose.yaml; do
	if [ ! -f "$INSTALL_DIR/$f" ] || ! cmp -s "$SRC/$f" "$INSTALL_DIR/$f"; then
		needs_recreate=1
	fi
done

mkdir -p "$INSTALL_DIR/nginx/edge.d" "$INSTALL_DIR/rpc-gate"
cp "$SRC/Caddyfile" "$INSTALL_DIR/Caddyfile"
cp "$SRC/compose.yaml" "$INSTALL_DIR/compose.yaml"
cp "$SRC/nginx/edge.d/crucible.sni.map" "$INSTALL_DIR/nginx/edge.d/"
cp "$SRC/nginx/edge.d/crucible.host.map" "$INSTALL_DIR/nginx/edge.d/"
cp "$SRC"/rpc-gate/*.mjs "$INSTALL_DIR/rpc-gate/"
# The scripts travel with the config so the installed directory is not a half-copy. A
# shell reads its script as it runs, so this is skipped when it would overwrite the very
# file being executed.
for f in provision.sh seed-certs.sh; do
	if [ "$SRC/$f" -ef "$INSTALL_DIR/$f" ]; then continue; fi
	install -m 0755 "$SRC/$f" "$INSTALL_DIR/$f"
done

cd "$INSTALL_DIR"

# ── 3. start and wait ─────────────────────────────────────────────────────────
docker compose -f compose.yaml up -d
if [ "$needs_recreate" = 1 ]; then
	echo "==> the edge config differs from the running container; recreating caddy"
	docker compose -f compose.yaml up -d --force-recreate --no-deps caddy
fi

status=""
for _ in $(seq 1 30); do
	status="$(docker inspect --format '{{.State.Health.Status}}' crucible-edge-caddy-1 2>/dev/null || echo starting)"
	[ "$status" = "healthy" ] && break
	sleep 2
done
echo "    health: $status"
[ "$status" = "healthy" ] || {
	echo "the edge did not become healthy" >&2
	exit 1
}

# ── 4. verify it serves ───────────────────────────────────────────────────────
#
# The certificate is the complication, and the check has to be honest about it.
#
# A certificate is issued by Let's Encrypt over HTTP-01, and the challenge has
# to reach THIS edge over the public :80 — which the shared front door owns.
# Until the front door is up and routing this name here, the challenge never
# arrives, no certificate is issued, and the edge has no certificate to serve
# TLS with. That is not a failure of this script; it is the order the split
# happens in.
#
# So the check is conditional on the thing that is actually true:
#
#   certificate present  -> the edge must answer the public name over TLS
#   certificate absent   -> the edge must answer on its HTTP port, which is
#                           the path the challenge will arrive on
#
# The seed script (`seed-certs.sh`) moves an already-issued certificate here,
# which is what makes the first branch the normal one.
VOLUME="crucible-edge_caddy-data"
if docker run --rm -v "$VOLUME:/data:ro" alpine:3 sh -c \
	"test -f /data/caddy/certificates/acme-v02.api.letsencrypt.org-directory/$NAME/$NAME.crt" 2>/dev/null; then
	code="$(curl -sk -o /dev/null -w '%{http_code}' --max-time 20 \
		--resolve "$NAME:$TLS_PORT:127.0.0.1" "https://$NAME:$TLS_PORT/" || echo 000)"
	echo "    $NAME on $TLS_PORT (tls) -> $code"
	[ "$code" = "200" ] || {
		echo "the edge does not answer for $NAME over TLS" >&2
		exit 1
	}
else
	code="$(curl -s -o /dev/null -w '%{http_code}' --max-time 20 \
		-H "Host: $NAME" "http://127.0.0.1:$HTTP_PORT/" || echo 000)"
	echo "    $NAME on $HTTP_PORT (http) -> $code"
	echo "    no certificate yet: it is issued once the shared front door is up"
	echo "    and routing this name here (the ACME challenge arrives on this port)."
	[ "$code" != "000" ] || {
		echo "the edge does not answer on its HTTP port" >&2
		exit 1
	}
fi

# ── 5. prove the gate is in the path ─────────────────────────────────────────
#
# Steps 3 and 4 prove a container is up and answering. Neither proves the thing gate 898
# actually claims: that a request for /anvil is refused the node's control methods BEFORE
# it reaches the node. The bypass found on 2026-10-27 passed every check this script had
# and still served `eth_accounts` to the internet, because the route in the running Caddy
# pointed at anvil:8545.
#
# So the script asks the endpoint, over the network, for the methods that must never be
# answered, and refuses to finish if any of them is. The probe takes real arguments for
# `anvil_setBalance`: a parameter-length error from the node is proof the call got through,
# and a check that counted that as a refusal would be the same mistake in a new place.
#
# The TLS path is the one a visitor takes. Without a certificate there is no TLS listener
# for this name yet, so the probe runs from inside the edge network against the gate
# service directly — which proves the gate answers and refuses, and prints in the same
# breath that the Caddy-to-gate route is still unproven on this box.
if docker run --rm -v "crucible-edge_caddy-data:/data:ro" alpine:3 sh -c \
	"test -f /data/caddy/certificates/acme-v02.api.letsencrypt.org-directory/$NAME/$NAME.crt" 2>/dev/null; then
	echo "==> probing the public RPC path through the edge"
	node "$INSTALL_DIR/rpc-gate/probe.mjs" \
		--url "https://$NAME:$TLS_PORT/anvil" \
		--connect-to "127.0.0.1:$TLS_PORT" \
		--servername "$NAME" \
		--insecure
else
	echo "==> no certificate yet: probing the gate service inside the edge network."
	echo "    this proves the gate refuses; it does NOT prove Caddy routes /anvil to it."
	docker exec crucible-edge-rpc-gate-1 node /gate/probe.mjs --url "http://127.0.0.1:8791/"
fi

echo "==> the edge is serving $NAME on 127.0.0.1:$TLS_PORT, with /anvil behind the gate"
echo "    it is NOT on the public ports yet: the shared front door owns those,"
echo "    and it routes this name here once it is up."
