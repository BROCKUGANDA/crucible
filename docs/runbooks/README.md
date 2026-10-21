# Runbooks

Operational procedures for the live demo. Each runbook is written to be
followed under pressure: symptom, first checks, decision tree, commands,
verification, and what not to do.

| Runbook                                                       | Use when                                                                                                        |
| ------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| [Site down / 502](site-down.md)                               | The public site answers 5xx, or the browser shows a proxy error while containers look healthy.                  |
| [Indexer stalled or reset](indexer-stalled-or-reset.md)       | `/api/ready` is false, the hall is empty, `indexedTo` and `head` look wrong, or the read model keeps resetting. |
| [Deploy and promote](deploy-and-promote.md)                   | Shipping `develop` → `staging` → `main`, or rebuilding a single service on the VPS.                             |
| [Voice host](voice-host.md)                                   | Configuring, rotating, disabling or debugging Frenchy/ElevenLabs.                                               |
| [Coinbase CDP CLI / Sandbox](coinbase-sandbox.md)             | Installing/configuring the `coinbase` and `cdp` CLIs, the Sandbox key, and the agent sandbox profile.           |
| [Contracts deploy and verify](contracts-deploy-and-verify.md) | Deploying the contracts, seeding the demo, or checking the live chain against the documented economics.         |
| [Incident response](incident-response.md)                     | A leaked key, a contract bug, a compromised dependency, or a suspected escrow issue.                            |

## The one-box facts

- VPS: `57.130.80.158`, user `ubuntu`, key `~/.ssh/akami`, tree `~/crucible`.
- Compose: `docker compose -f compose.yaml -f compose.vps.yaml`.
- Edge: a **shared** Caddy owned by `securevoice-ai`, attached to
  `crucible_default` by a host cron every two minutes.
- Edge log: `/home/ubuntu/crucible-edge-attach.log`.
- Public checks: `https://crucible.svalley.tech/` and `/api/ready`.
- Security contact: see [`SECURITY.md`](../../SECURITY.md); do not open a public
  issue for a vulnerability.

## Ground rules

- Do not recreate the shared Caddy unless you have to; it fronts another
  product. Attach the network instead.
- Do not run a full `docker compose up` on a live chain. It can re-evaluate the
  seed and land at different addresses. Use `--no-deps` for one service.
- Do not delete the chain, the cursor file, or a container's volume to "reset"
  a symptom until you have read the indexer runbook.
- Record what you changed (host crontab, `.env`, image tag) in the incident
  notes and the changelog.
