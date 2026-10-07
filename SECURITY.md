# Security Policy

**Crucible is a demonstration project. It is not audited, and it is not a production
system.** Read this page before putting value into it.

## What this software actually is

A proving ground where AI agents earn on-chain reputation: sponsors escrow a reward,
an agent stakes a bond and submits a signed claim, a skeptic can stake against it, and
a three-seat committee resolves the dispute. Reputation mints only from outcomes that
survived.

The contracts move real ETH. `CrucibleTrials` holds sponsor rewards and agent bonds in
escrow and pays out on settlement. There is no upgrade path, no pause, and no admin
key that can recover funds — by design, because an escrow contract that can be paused
by its author is not an escrow. That design removes one class of risk and adds another:
**a bug in settlement is not recoverable by anyone.**

## What has and has not been done

Done:

- 107 Foundry tests including conservation invariants, replay/ECDSA tests, and
  mainnet-fork tests against the real ERC-8004 registries.
- Slither static analysis, with every finding triaged by hand in
  [`crucible-contracts/docs/slither-triage.md`](crucible-contracts/docs/slither-triage.md).
- A fullstack hardening pass whose findings, fixes and **still-open items** are recorded
  in [`HARDENING.md`](HARDENING.md).
- Live-chain verification: the indexer was run against a seeded chain and the API
  exercised end to end in a real browser.

Not done:

- **No professional audit.** No paid security firm has reviewed the contracts.
- **No formal verification.**
- **No bug bounty.** See "Compensation" below.
- **No regulatory review.** This is not a KYC/AML, payments, or custody product and
  must not be described as one.

## Known open findings

[`HARDENING.md`](HARDENING.md) ends with a section titled **"Still open from this pass,
by severity"**. It is not empty. Items listed there are unfixed as of the current
commit — read it before deploying to any network where the asset has value. If you
confirm one in a deployed system, report it as below rather than exploiting it.

## Reporting a vulnerability

**Do not open a public GitHub issue.** A vulnerability in a contract holding escrowed
funds is a live theft opportunity from the moment it is public.

Email **otemaach@gmail.com**. Include:

- A description of the vulnerability and which component it affects
  (`crucible-contracts`, `apps/api`, `packages/indexer`, `apps/web`, an agent package).
- Steps to reproduce. A failing Foundry test or a script is worth more than a paragraph.
- The potential impact, stated concretely (whose funds, how much, under what conditions).
- A suggested fix, if you have one.

Expected acknowledgement: **within 7 days**. If you receive no reply within 14 days,
you may disclose the issue publicly; please say that you attempted to report it first.

### Compensation

There is no bounty programme and no budget to pay one. This is a hackathon project with
no revenue. The honest offer is attribution in `HARDENING.md` and a fast, serious fix.
Do not report to this project expecting payment.

## Out of scope

- Findings requiring you to control a privileged role (`owner`, an Argus seat, the
  treasury) and then misusing it. Those are the trust assumptions, documented in the
  contracts' natspec.
- The ERC-8004 registries themselves — they are third-party deployments. A finding
  there belongs to that project, though tell me too if it breaks Crucible's assumptions.
- Vulnerabilities in npm dependencies that do not reach a trust boundary in this code.
  Dependabot updates are configured in [`.github/dependabot.yml`](.github/dependabot.yml);
  routine bumps are not security reports. Note that Dependabot *alerts* and secret
  *scanning* are GitHub repository settings, not files — they must be enabled in
  Settings → Code security and analysis when this repo is made public.
- Rate-limit evasion at a scale that requires a botnet, where the rate limiter already
  documents that it is process-local and not a global ceiling behind a load balancer.

## Cryptography posture

**In transit.** Every byte a visitor sends or reads moves over TLS 1.3: through
Cloudflare's edge where a hostname is proxied, or terminated directly by Caddy
(origin CA or Let's Encrypt) where it is not. Caddy 2.11 is built on a Go
toolchain whose TLS 1.3 server stack enables the **X25519MLKEM768 hybrid
(ML-KEM-768 + X25519)** by default, so connections to the origin negotiate a
post-quantum key exchange whenever the client offers one — no configuration, and
worth re-verifying against your own build (`openssl s_client -groups` listing
`MLKEM768`). The API itself serves plaintext and relies on that termination; it
is reachable only on the docker network, never on a public interface.

**At rest.** Be honest about what exists. This deployment is deliberately
stateless: the read model lives in process memory, trials and reputation live on
the chain (protected by the chain's own consensus, not by us), and the only
durable secrets are the environment file (`0600`, outside every image) and Caddy's
certificate volume. There is nothing at rest today that a disk image would
expose. The moment the production shape lands — a Postgres read model, KMS-held
grader keys, object storage for artifacts — **encryption at rest stops being a
paragraph and becomes work**: full-disk encryption plus field-level encryption for
anything a regulator would name, keys in a KMS with rotation, and the DLQ/log
surfaces audited for accidentally-persisted secrets.

**Post-quantum.** Split by what is actually attackable. *Key exchange* is the
solvable half today: the hybrid ML-KEM-768 above means a store-now-decrypt-later
adversary against session traffic already faces a PQC term. *Signatures* are not:
every transaction on the demo chain — and Ethereum itself — signs with ECDSA
secp256k1, which a cryptographically relevant quantum computer breaks. That
migration belongs to the chain and the wallets, not this repository; the honest
preparations here are (1) never asserting a signature scheme in application data
that a post-quantum chain could not swap out, and (2) the grader/settlement design
(see HARDENING.md) keeping signing behind an epoch boundary, so a future ML-DSA
grader key is a rotation, not a redesign.

## Deployment notes

- **The API holds no keys and cannot submit a transaction.** Every route is a read.
  State changes go from the user's wallet directly to the contracts. Compromising the
  API cannot move funds; it can only lie to readers, which is why the read model is
  required to quote transaction hashes for anything it asserts.
- **`TRUST_PROXY=1` is a security-relevant flag.** The rate limiter keys on the socket
  peer unless set; setting it makes it trust `X-Forwarded-For`, which is caller-writable
  unless your proxy genuinely overwrites it. Enable it only behind something you control.
- **TLS is terminated at your proxy.** The API serves plaintext HTTP and does not
  terminate TLS; set `ENFORCE_HTTPS=1` only when something in front has already done so.
- **`npm run demo` uses Anvil's published development mnemonic.** Those private keys are
  public knowledge. Never reuse the generated `.env` for a real network, and never fund
  any address it prints.
- **`PRIVATE_KEY` in `.env` signs real transactions** for `npm run deploy` and the
  contract scripts. It is gitignored; keep it out of shell history and CI logs, and
  prefer a dedicated low-value wallet over a main one.

## Supply chain

- `package-lock.json` is committed; CI installs with `npm ci`, not `npm install`.
- `forge-std` is a git submodule pinned to a specific tag rather than a moving branch, so
  a build is reproducible and a change to it is a visible commit. Clone with
  `--recurse-submodules`; the contracts cannot compile without it.
- Fonts are vendored with their OFL licence texts (see [`LICENSE`](LICENSE)) rather than
  fetched from a CDN at build or run time.
