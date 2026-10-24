# CRUCIBLE on Solana — work escrow (gates 701–720)

The EVM contracts (`../contracts/RewardMath.sol`, the Foundry invariant suite) are
the oracle. This Anchor program is a mirror, not a mutation: same state machine
(Open → Posted → Settled | Expired, Disputed as an overlay that can only exist
while Posted), same reward flow table, same conservation law, same fail-closed
posture. Where the chains genuinely differ, the deviation is written down below.

Spec: `docs/solana-spec.md` gates 701–720 (kept in the repo root docs tree).

## Layout

```
Anchor.toml                     # pinned toolchain + program id (gate 701)
Cargo.toml                      # workspace
.cargo/config.toml              # MSRV-fallback resolver (see Toolchain)
programs/work-escrow/
  src/lib.rs                    # entrypoint + instruction dispatch
  src/state.rs                  # escrow account, EVM struct mirrored (gate 704)
  src/math.rs                   # RewardMath ported, pure + host-tested (gates 707-711)
  src/errors.rs                 # typed fail-closed table (gate 705)
  src/instructions/             # open/post/settle/dispute/resolve/expire
tests/work-escrow.ts            # e2e flow-table suite against localnet (gate 716)
scripts/check-cpi-allowlist.mjs # gate 702 enforcer
scripts/toolchain-pin.sh        # blake3 1.5.1 floor pin (see Toolchain)
```

## Toolchain (gate 701 — pinned, do not float)

Verified working together on Linux (WSL Ubuntu 26.04, x86_64), 2026-10-24:

| Piece | Version | Notes |
|---|---|---|
| rustup / rustc (host) | stable (1.99.1 at pin time) | minimal profile; host unit tests + dependency resolution |
| anchor-cli | **0.30.1** | `cargo install anchor-cli --version 0.30.1` — **no prebuilt binaries exist for 0.30+**; ~20+ min compile |
| build + localnet | **solana-labs v1.18.26 release** | ONE tarball: `solana`, `solana-test-validator`, `solana-keygen`, `cargo-build-sbf`, platform-tools **v1.41** (rustc 1.75) bundled — nothing fetched post-install |
| anchor-lang / anchor-spl | 0.30.1 | workspace deps |

Why v1.18.26 and not Agave: the earlier pins (agave 3.0.0 build / 2.3.6 localnet)
were recorded in an environment whose GitHub could reach the anza org. This one
cannot, and on crates.io those names publish as library-only crates with no
binaries to install. v1.18.26 is anchor 0.30.1's contemporary — the pairing the
framework was actually built against — and it was the original setup-list pin.

```bash
# 1. host toolchain
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y --profile minimal

# 2. anchor CLI (the long pole)
cargo install anchor-cli --version 0.30.1

# 3. the one-tarball Solana toolchain (build + validator + sbf + platform-tools)
mkdir -p ~/solana-toolchain && cd ~/solana-toolchain
curl -sL -o release.tar.bz2 \
  https://github.com/solana-labs/solana/releases/download/v1.18.26/solana-release-x86_64-unknown-linux-gnu.tar.bz2
tar xjf release.tar.bz2
export PATH="$HOME/solana-toolchain/solana-release/bin:$HOME/.cargo/bin:$PATH"

# 4. localnet wallet, made by hand (a build script does not generate key material)
solana-keygen new --no-bip39-passphrase

# 5. build — scripts/build-local.sh also handles the lockfile dance below
bash scripts/build-local.sh

# 6. suites
cargo test -p work-escrow        # host: RewardMath rows, no BPF toolchain needed
npm install && npm run test:lint # CPI allowlist (gate 702)
anchor test                      # e2e flow table against localnet (gate 716)
```

Environment constraints the next person will hit (all three are environment
facts, not design decisions):

1. **Lockfile v4 vs platform-tools v1.41.** Cargo ≥1.78 writes v4 lockfiles;
   platform-tools v1.41's cargo predates them and aborts with
   "requires -Znext-lockfile-bump". Cargo *preserves* a complete v3 lock, so
   the fix is: resolve fully with the modern cargo, flip the version line to
   3 (registry-dep encoding is identical), and build — `scripts/build-local.sh`
   automates this. An *empty* v3 seed does NOT work; cargo regenerates it as v4.
2. **rustc 1.75 vs edition-2024 crates.** The SBF rustc is 1.75; late-2025
   transitive crates may declare newer. `.cargo/config.toml` sets
   `[resolver] incompatible-rust-versions = "fallback"` (host cargo ≥1.84,
   which drives resolution) so the resolver prefers versions the target can
   build; `scripts/toolchain-pin.sh` floors blake3 at 1.5.1.
3. **anchor 0.30+ ships no prebuilt binaries.** `cargo install` is the only
   path; budget 20+ minutes.

## Deviation table — where this port differs, and why

| # | Deviation | Reason |
|---|---|---|
| 1 | **Fee is 5% (500 bps), not the spec prose's 15%.** | `RewardMath.sol` — the economic source of truth this port must mirror byte-for-byte — is `FEE_BPS = 500`. AGENTS.md makes the 5% load-bearing and names a 15% change a product pivot requiring a new ADR. The pasted spec's "15%" is the external-PRD number that law exists to reject. |
| 2 | **Funding is two transfers (reward at `open_escrow`, stake at `post_work`), not one.** | The spec prose says post_work pulls stake+reward+fee in ONE transfer, but an SPL transfer has one source and the money belongs to two parties (funder's reward, worker's stake). The EVM rows are the binding semantics: funder→escrow at open, worker→escrow at post. Each instruction still moves value exactly once. |
| 3 | **Expiry slot is recorded at `open_escrow` (funder-controlled), checked at post/settle/expire.** | Spec prose says post_work records the expiry; a worker-controlled deadline at post would let the worker extend it. The funder's deadline at open mirrors the EVM law (`deadline > block.timestamp + minWindow` at task creation). |
| 4 | **Dispute fee is forfeited to the protocol treasury on resolve, both outcomes.** | The resolve context carries no disputer token account; routing the fee anywhere else would need one. The spec records this as the honest reason for the row. |
| 5 | **Conservation asserts at the END of each instruction, after transfers.** | Solana transactions are atomic — a late assert reverts the transfers too, so it verifies the settled end-state. EVM asserts before the write; both are fail-closed, the placement follows the chain's semantics. |
| 6 | **Resolve requires the `resolver` authority recorded at open.** | The EVM side settles disputes through the Argus committee; a permissionless resolve would let anyone flip outcomes. The resolver field is that committee slot (demo: the funder). |

## Gates 701–720 → code

| Gate | Where |
|---|---|
| 701 pinned toolchain | `Anchor.toml` header, this file, `scripts/toolchain-pin.sh` |
| 702 CPI allowlist | `scripts/check-cpi-allowlist.mjs` (`npm run test:lint`) |
| 703 PDA seeds | `state.rs` doc, seeds in every Accounts struct |
| 704 account layout + version | `state.rs` (`ESCROW_VERSION`, field-for-field mirror) |
| 705 typed errors | `errors.rs` |
| 706 stake only in PDA vault | vault authority = escrow PDA; no other move path |
| 707 fee frozen at post | `post_work.rs` → `math::split_post_work` → `fee_held` |
| 708 fail/expiry return fee | `settle.rs`, `expire.rs` |
| 709 dispute economics | `resolve_dispute.rs` |
| 710 stake floor + checked math | `open_escrow.rs` records, `post_work.rs` enforces; all math checked |
| 711 conservation | `instructions/mod.rs::assert_conservation`, every handler's last call |
| 712 verdict hash binding | `post_work.rs` (record + cross-check), `settle.rs` (match to pay) |
| 713 slot→time constant | `state.rs::SLOTS_PER_SECOND_ESTIMATE`, deviation table |
| 714 CEI order | effects first, `transfer_out` last, no CPI after value |
| 715 upgrade authority | runbook item (mainnet-era; localnet demo: single key) |
| 716 mirror tests | `math.rs` tests (host) + `tests/work-escrow.ts` (e2e) |
| 717 event parity | mainnet-era: Anchor emits vs EVM events (not yet wired) |
| 718 eval→settle integration | mainnet-era CI job (spec section "Test strategy") |
| 719 Token-2022 rejected | `open_escrow.rs` mint constraint |
| 720 spec sync | this README + `docs/solana-spec.md` |

## Out of scope, on the record (per the spec)

Keepers/cranks beyond expiry, cross-chain settlement bridges, and vault yield —
all mainnet-era decisions; the demo needs exactly one permissionless crank.
