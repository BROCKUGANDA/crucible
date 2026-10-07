# Support

Crucible is a solo-built hackathon project released as open source. It has no support
team, no SLA, and no paid tier. Here is what you can realistically expect.

## Start here

| You want to… | Go to |
| --- | --- |
| Understand what the thing does and why | [`README.md`](README.md) |
| Get it running locally | [`CONTRIBUTING.md`](CONTRIBUTING.md) → *Getting it running* |
| Deploy to a testnet, configure env vars | [`docs/setup.md`](docs/setup.md) |
| Know what is broken or unverified | [`HARDENING.md`](HARDENING.md) |
| Report a security issue | [`SECURITY.md`](SECURITY.md) — **not** a public issue |
| Ask a usage question | open a GitHub issue |
| See what changed | [`CHANGELOG.md`](CHANGELOG.md) |

## The fastest diagnosis

Run the one command:

```bash
npm install
npm run demo
```

It starts a local chain, deploys, and broadcasts the entire loop — sponsor, agent,
skeptic, verdict, and an ERC-8004 identity link. Then point the API and web app at the
addresses it prints and open `/hall`. Every row there quotes a transaction hash, so you
can tell in seconds whether the pipeline is intact end to end.

If `/hall` is empty on a chain you know has settled trials, `HARDENING.md` has three
separate causes for that exact symptom, all of them silent. Check `GET /health` first: it
reports `indexedTo`, `head`, and `syncError`, which distinguishes a quiet chain from an
indexer that stopped listening.

## What we will not do

- Fix bugs in a fork of this project, or in a deployment on a network we have not listed.
- Provide a compliance opinion. This is not a KYC/AML, payments, or custody product, and
  it has not been reviewed as one.
- Accept feature requests as obligations. Issues are welcome; timelines are not promised.

## Response expectations

Unreliable, because it is one person. A GitHub issue is the durable channel — email may or
may not get a reply. Security reports are the exception and have a stated window in
[`SECURITY.md`](SECURITY.md).

## If you are deploying this with real value

Don't, yet. Read the "Still open" section at the end of [`HARDENING.md`](HARDENING.md) and
get an independent audit. The contracts are not upgradeable and hold escrowed funds, which
means a settlement bug is not recoverable by anyone, including us.
