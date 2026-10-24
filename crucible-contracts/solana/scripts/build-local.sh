#!/usr/bin/env bash
# Gate 701 helper — build the program against the pinned local toolchain.
#
# Expects the solana-labs v1.18.26 release unpacked at ~/solana-toolchain
# (see README "Toolchain") and rustup on PATH. Idempotent: safe to re-run.
set -euo pipefail

export PATH="$HOME/solana-toolchain/solana-release/bin:$HOME/.cargo/bin:$PATH"

command -v solana >/dev/null || { echo "solana CLI not on PATH — see README Toolchain" >&2; exit 2; }
command -v anchor >/dev/null || { echo "anchor-cli 0.30.1 not on PATH — cargo install anchor-cli --version 0.30.1" >&2; exit 2; }

# Provider wallet for localnet (anchor test reads ~/.config/solana/id.json).
# A build script does not silently generate key material: if the wallet is
# missing, stop and say the command. Run it once by hand.
if [ ! -f "${HOME}/.config/solana/id.json" ]; then
  cat >&2 <<'MSG'
build-local: no localnet wallet at ~/.config/solana/id.json.
Create one by hand (it is throwaway localnet key material, yours to make):
  solana-keygen new --no-bip39-passphrase
MSG
  exit 3
fi

cd "$(dirname "$0")/.."

# Lockfile dance (README "Toolchain" #1): platform-tools v1.41's cargo cannot
# read a v4 lockfile, and an EMPTY v3 seed does not survive — cargo regenerates
# it whole, as v4. A COMPLETE v3 lock is preserved by every cargo in the tree.
# So: resolve fully with the modern host cargo, flip the version line (registry
# deps are encoded identically in v3 and v4), then build.
if ! grep -q '^version = 3$' Cargo.lock 2>/dev/null; then
  rm -f Cargo.lock
  cargo generate-lockfile >/dev/null
  sed -i 's/^version = 4$/version = 3/' Cargo.lock
  echo "build-local: Cargo.lock resolved and pinned at version 3"
fi

anchor build
