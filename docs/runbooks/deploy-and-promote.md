# Runbook: deploy and promote

## Branch ladder

| Branch    | What it holds                             |
| --------- | ----------------------------------------- |
| `develop` | Integration. Everything lands here first. |
| `staging` | What production will be, one gate ahead.  |
| `main`    | What is live. A push to `main` deploys.   |

`promote.yml` promotes a green `ci` run: `develop → staging → main`. The
promotion pushes with `GITHUB_TOKEN`, which suppresses workflow triggers, so it
must ask for the next gate explicitly. Do not promote by force-pushing.

## Normal path

1. Commit on `develop`; push.
2. Wait for `ci.yml`: forge fmt/build/tests/coverage/slither, every TypeScript
   workspace, `next build`, dependency audit, gitleaks.
3. Let `promote.yml` move `develop → staging`, then `staging → main`.
4. `deploy.yml` runs on `main` on the VPS runner: sync to `~/crucible`, build
   `web` and `api` **before** the swap, then `up -d --no-deps`, and gate on
   `/api/health`.
5. Verify the public site and `/api/ready`.

## Manual single-service rebuild (incident path)

Use this only when a running image is wrong and the pipeline is unavailable.
It does not replace a commit; record the source change and commit it.

```bash
ssh -i ~/.ssh/akami ubuntu@57.130.80.158
cd ~/crucible
docker compose -f compose.yaml -f compose.vps.yaml build api   # or web
docker compose -f compose.yaml -f compose.vps.yaml up -d --no-deps api
```

- Never run a full `up` on a live chain; it may re-evaluate the seed and land at
  different addresses.
- The API image's build runs `build:libs` and the API `tsc`; a type error stops
  the build and leaves the old image running.
- The web's `NEXT_PUBLIC_*` values are baked at build time. Changing them in a
  running container does nothing; rebuild.
- Check disk first (`df -h /`, `docker system df`). The VPS shares its Docker
  cache with other projects; do not prune blindly.

## Before a deploy

- `git status` is clean on the deployment tree and the branch is the intended
  one.
- The host `.env` is not synced from the repo; it holds the deployment's
  addresses and secrets. Do not overwrite it.
- The edge cron is present and its log is writable:
  `crontab -l | grep crucible-edge`.
- Recent changes that touch the indexer, the read model or the API have a
  runbook entry and a regression test.

## After a deploy

```bash
curl -sS -o /dev/null -w 'site %{http_code}\n' https://crucible.svalley.tech/
curl -sS https://crucible.svalley.tech/api/ready
curl -sS https://crucible.svalley.tech/api/health
```

Expect 200, `ready:true`, lag 0, no `syncError`. Then load `/hall`,
`/trials`, `/agents`, and a trial detail page. If the deploy gates on
`/api/health` but the site is 502, check the edge attachment.

## Rollback

There is no image-tag history to flip. The safe rollback is a `git revert` of
the offending commit on `develop`, then the normal promotion path. For a
contract change, a rollback is a **redeploy**; the contracts are not
upgradeable and an old deployment keeps its state.

## Do not

- Do not force-push `main` or `staging`.
- Do not bypass `ci` to ship a contract or indexer change.
- Do not recreate the shared Caddy.
