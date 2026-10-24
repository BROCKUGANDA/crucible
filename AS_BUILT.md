# AS_BUILT — what exists, at which versions, proven when

Gate 731's comparison target (v2 bible §3.3). Every entry names the proof that last
showed it green and the date. A tool or artifact not listed here is not claimed.

## Toolchain (Solana workstream — proven 2026-10-24)

| Piece | Version | Proof |
| --- | --- | --- |
| host rustc/cargo | stable 1.99.1 (rustup, minimal) | `cargo test -p work-escrow`: green in the 2026-10-24 WSL session. Re-counted in the tree on 2026-10-24: `programs/work-escrow/src/math.rs` carries **11** `#[test]`, and they are the only ones in `programs/` — the earlier row said 12/12. The 3 vectors tests live in the sibling `vectors` crate and are not run by `-p work-escrow`. **No CI job runs any of it** (see `HARDENING.md` still-open 13) |
| anchor-cli | 0.30.1 (built from source) | `anchor build` produced the `.so`; `anchor test` 10/10 on localnet |
| Solana build + localnet | solana-labs **v1.18.26** release tarball (`solana`, `solana-test-validator`, `solana-keygen`, `cargo-build-sbf`; platform-tools **v1.41**, rustc 1.75, bundled) | e2e run 2026-10-24; amends D-13 for this machine — agave 3.0.0/2.3.6 unreachable here (org does not resolve; crates.io names are library-only) |
| lockfile discipline | Cargo.lock v3. **Script-enforced floor pins — three, in `crucible-contracts/solana/scripts/toolchain-pin.sh`:** blake3 1.5.1 (`:28`), proc-macro-crate 3.1.0 (`:32`), indexmap 2.11.0 (`:36`) | the build logs in the 2026-10-24 session |
| resolved-but-not-pinned | zeroize_derive 1.4.2, borsh 1.5.1 (alongside 0.9.3/0.10.4), unicode-segmentation 1.12.0, cc 1.1.6, jobserver 0.1.31 are what `Cargo.lock` resolved to on 2026-10-24. They are **not** in `toolchain-pin.sh`, so `build-local.sh:33-34` (`rm -f Cargo.lock`, then `cargo generate-lockfile`) will not restore them; a verifiable rebuild needs them pinned before it needs a claim | measured 2026-10-24: `grep -cE "^pin " scripts/toolchain-pin.sh` = 3 |
| Node / npm | 24.x / 11.x (Windows host + WSL) | `npm test`: 1360 TS tests green |

## Program ids (localnet; devnet deploys pending P1-close)

| Program | Id | Notes |
| --- | --- | --- |
| `work_escrow` (Solana, localnet) | `AnctSTeT8TNQ4riTxkh8Kh8hKpQGfmhQjhd3M15VaJAD` | Re-synced 2026-10-24 to the local keypair (`target/deploy/work_escrow-keypair.json`, gitignored). The bible's `7Tvrs…` id is retired: its keypair never existed in this repo. `.so` ≈ 367 KB, sha256 not yet recorded — record at the devnet deploy |
| `crucible-arena` (Solana, v2) | — | Not yet built (P4) |
| EVM contracts | Anvil/local, chain 31337; addresses in `apps/web` deployment env | Foundry 144 tests + coverage gate green 2026-10-23 |

## Params (v2)

`params/crucible.params.json` is the single source (ADR-0011, gate 732). Generated
artifacts in `params/generated/`. Invariants 5/5 proven; drift check green; the legacy
freeze (500 bps v1) is asserted and mutation-proven red.

## What is deliberately not claimed

Devnet deployment (722), deterministic-build `solana-verify` (723), the arena program,
Harena, Argus node, Standing, the agent surface, the app shell — all P2+ per the bible's
§25, not yet started in this repo.
