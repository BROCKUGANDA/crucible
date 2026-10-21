# Runbook: site down / 502

## Symptom

- `https://crucible.svalley.tech/` returns 502/503/521, or the browser shows a
  proxy error.
- Containers may all report `healthy`; that is the normal shape of this
  failure. The edge is a separate project's container.

## First five minutes

1. Confirm from outside:
   ```bash
   curl -sS -o /dev/null -w '%{http_code}\n' https://crucible.svalley.tech/
   curl -sS https://crucible.svalley.tech/api/ready
   ```
2. SSH and check the stack:
   ```bash
   ssh -i ~/.ssh/akami ubuntu@57.130.80.158
   cd ~/crucible
   docker compose -f compose.yaml -f compose.vps.yaml ps
   docker ps --format '{{.Names}}\t{{.Status}}' | grep -E 'crucible|caddy'
   ```
3. Check the API internally:
   ```bash
   docker exec crucible-api-1 wget -qO- http://127.0.0.1:8787/ready
   docker exec securevoice-ai-caddy-1 wget -qO- http://web:3000/ | head -c 200
   ```
   A working `web:3000` and a failing public request points at the edge.

## The shared edge

The site is served by `securevoice-ai-caddy-1`, which must be attached to
`crucible_default`:

```bash
docker inspect securevoice-ai-caddy-1 \
  --format '{{range $k,$v := .NetworkSettings.Networks}}{{$k}} {{end}}'
```

If `crucible_default` is missing, attach it with the repository's script:

```bash
/usr/local/bin/crucible-edge-attach
# or, from the checkout:
sh deploy/edge-attach.sh
```

The host crontab should run it every two minutes and write to a writable file:

```bash
crontab -l | grep crucible-edge
# */2 * * * * /usr/local/bin/crucible-edge-attach >> /home/ubuntu/crucible-edge-attach.log 2>&1
tail -20 /home/ubuntu/crucible-edge-attach.log
```

If the cron points at `/var/log/...` and the file is not writable by `ubuntu`,
the redirect fails before the script runs. The repair workflows install the
home-directory path; if the host was reverted by an old deploy, fix the
crontab again or redeploy the fixed workflow.

## The route

The edge's site block is on the host, not in this repository:

```bash
grep -n -A 40 'crucible.svalley.tech' /home/ubuntu/securevoice-ai/sites.d/crucible.caddy
```

It must proxy `/api/*` to `api:8787` and `/` to `web:3000`. After editing that
shared config, validate/reload Caddy rather than recreating it.

## If the app is up but the hall is empty

Go to [indexer-stalled-or-reset.md](indexer-stalled-or-reset.md). A 200 page
with an empty hall is a data-plane failure, not an edge failure.

## Verify

```bash
curl -sS -o /dev/null -w 'site %{http_code}\n' https://crucible.svalley.tech/
curl -sS https://crucible.svalley.tech/api/ready
```

Expect `site 200` and `ready:true`, `lag:0`. The edge should list both
`crucible_default` and its own network.

## Do not

- Do not restart/recreate the shared Caddy as a first move; it serves another
  product.
- Do not run a full `docker compose up` on a live chain.
- Do not clear the indexer's model or cursor to make `/ready` green.
