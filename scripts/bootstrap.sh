#!/usr/bin/env bash
# ── fresh-box bootstrap ────────────────────────────────────────────────────────
# From a bare host with Docker installed to a running Crucible demo.
#
# `deploy/edge/provision.sh` reconciles the EDGE of an already-installed box. This is
# its first-boot companion: it orders the install that used to be tribal knowledge in
# docs/runbooks/credentials-and-deploy.md §3 —
#
#   1. prerequisites (Docker Engine; compose >= 2.24, because `!reset` is what makes the
#      no-publish overlay possible and older compose silently merges the ports back)
#   2. a host `.env` scaffold with names only: secrets are copied by hand, never written
#      by this script, never echoed, never in a log
#   3. the application stack (network + one-shot seed + services, no origin port)
#   4. the edge install and its RPC-gate probe (deploy/edge/provision.sh)
#   5. the public probes the deploy pipeline runs after every swap, when PUBLIC_URL is set
#
# Refuse loudly and early. Never `down -v` against a shared host. Never print a value
# from `.env`.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

say() { printf '%s\n' "==> $*"; }
die() { printf 'bootstrap: %s\n' "$*" >&2; exit 1; }

# ── 1. prerequisites ──────────────────────────────────────────────────────────
command -v docker >/dev/null 2>&1 ||
  die "docker is not installed. Install Docker Engine first; this script does not install it."
docker info >/dev/null 2>&1 ||
  die "the docker daemon is not reachable as this user. Add the operator to the docker group (and re-login) or run with appropriate privileges."

compose_version="$(docker compose version --short 2>/dev/null | sed 's/^v//')" || compose_version=""
[ -n "$compose_version" ] || die "docker compose v2 is required (docker compose version failed)."
major="${compose_version%%.*}"
rest="${compose_version#*.}"
minor="${rest%%.*}"
if [ "$major" -lt 2 ] || { [ "$major" -eq 2 ] && [ "$minor" -lt 24 ]; }; then
  die "docker compose >= 2.24 is required for '!reset' (found $compose_version). Older compose merges the ports the no-publish overlay exists to remove, which would expose the origin."
fi

free_kb="$(df -Pk "$ROOT" | awk 'NR==2 {print $4}')"
[ "${free_kb:-0}" -ge 5242880 ] ||
  die "less than 5 GiB free under $ROOT; images and chain state need room. Free space (docker image prune, old logs) or move the install."

# ── 2. host env: names only, values by hand ───────────────────────────────────
if [ ! -f "$ROOT/.env" ]; then
  cp "$ROOT/.env.example" "$ROOT/.env"
  say "wrote .env from .env.example. Fill these BY HAND before exposing the host:"
  say "  AUTH_SECRET, DEPLOYER_PRIVATE_KEY, KEEPER_PRIVATE_KEY, JUROR_SEAT_PRIVATE_KEY,"
  say "  TOKENXYZ_API_KEY, ELEVENLABS_API_KEY"
  say "Values are never written by this script and never echoed; see docs/runbooks/credentials-and-deploy.md."
else
  say ".env exists; leaving it untouched (the secrets belong to the operator)."
fi

# ── 3. the application stack ──────────────────────────────────────────────────
# The vps overlay publishes no host port: only the edge can reach these services. The seed
# runs once, before the build (below), so the later full `up` finds it already satisfied.
# The web bundle inlines TRIALS_ADDRESS / ALLOY_ADDRESS at build time, so the chain must be
# deployed BEFORE web is built. Order: build seed -> run seed (anvil starts as its dependency)
# -> read the addresses it published -> build the rest -> up.
say "building the seed image"
docker compose -f compose.yaml -f compose.vps.yaml build seed

say "deploying the chain (anvil + one-shot seed) so the addresses exist before the web build"
docker compose -f compose.yaml -f compose.vps.yaml run --rm -T seed

say "reading the deployed addresses from the seed volume"
deployed_env="$(docker compose -f compose.yaml -f compose.vps.yaml run --rm -T --no-deps \
  --entrypoint cat seed /run/crucible/deployed.env)" ||
  die "could not read /run/crucible/deployed.env from the seed volume."
TRIALS_ADDRESS="$(printf '%s\n' "$deployed_env" | sed -n 's/^TRIALS_ADDRESS=//p' | tail -n 1)"
ALLOY_ADDRESS="$(printf '%s\n' "$deployed_env" | sed -n 's/^ALLOY_ADDRESS=//p' | tail -n 1)"
[ -n "$TRIALS_ADDRESS" ] && [ -n "$ALLOY_ADDRESS" ] ||
  die "the seed did not publish TRIALS_ADDRESS and ALLOY_ADDRESS."
# Exported so compose interpolates them into the web build args and into the seed's EXPECTED_*
# guard: the later `up` then keeps the deployed chain instead of re-broadcasting the demo.
export TRIALS_ADDRESS ALLOY_ADDRESS

say "building the application images (web bakes the addresses above)"
docker compose -f compose.yaml -f compose.vps.yaml build web api keeper juror funder

say "starting the stack (anvil -> seed -> api/keeper/funder; origin ports unpublished)"
docker compose -f compose.yaml -f compose.vps.yaml up -d

# ── 4. the edge ───────────────────────────────────────────────────────────────
say "installing the edge (Caddy + the RPC method gate) and probing it"
bash "$ROOT/deploy/edge/provision.sh"

# ── 5. public probes ──────────────────────────────────────────────────────────
if [ -n "${PUBLIC_URL:-}" ]; then
  say "probing the public surface at $PUBLIC_URL"
  node "$ROOT/deploy/edge/rpc-gate/probe.mjs" --url "$PUBLIC_URL/anvil"
  if [ -f "$ROOT/deploy/edge/public-origin/probe.mjs" ]; then
    node "$ROOT/deploy/edge/public-origin/probe.mjs" --url "$PUBLIC_URL"
  fi
else
  say "PUBLIC_URL is not set; skipping the public probes."
  say "Re-run with PUBLIC_URL=https://<host> once DNS and the front-door route point here."
fi

say "done — origin ports are unpublished, the edge listens on host loopback, the front door routes to it"
