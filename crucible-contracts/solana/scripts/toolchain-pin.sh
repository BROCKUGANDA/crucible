#!/usr/bin/env bash
# Gate 701 — the crate floor pins the SBF toolchain needs, applied after the
# first lockfile generation. Run once after `cargo generate-lockfile` (or a
# failed first `anchor build`), then re-run the build. The lock is committed.
#
# Why these pins exist: platform-tools v1.41 (the SBF toolchain inside the
# solana-labs v1.18.26 release) carries cargo 1.75, which cannot even PARSE an
# edition-2024 manifest. The host cargo resolves for its own (modern) version,
# so late-2025 crates keep walking the lock forward; each pin below is one
# that actually bit, discovered by building, named by cargo's parse error.
set -euo pipefail

if [ ! -f Cargo.lock ]; then
  echo "toolchain-pin: Cargo.lock not found — generate it first (cargo generate-lockfile)" >&2
  exit 2
fi

pin() { # pin <crate@current> <target>
  if cargo update -p "$1" --precise "$2" >/dev/null 2>&1; then
    echo "toolchain-pin: $1 -> $2"
  else
    echo "toolchain-pin: $1 not at the expected version or already pinned — skipped"
  fi
}

# blake3 1.8+ requires cpufeatures 0.3 (edition2024). 1.5.1 is the pin the
# original toolchain note recorded, and solana-program's ^1.5.0 accepts it.
pin blake3@1.8.7 1.5.1

# proc-macro-crate 3.2+ pulls the toml_edit 0.25 / toml_datetime 1.x family
# (edition2024). 3.1.0 rides the edition2021 toml stack.
pin proc-macro-crate@3.5.0 3.1.0

# hashbrown 0.17 is edition2024, reached through indexmap 2.12+ (toml_edit's
# indexmap). Pinning indexmap to the 2.11 line drops hashbrown to 0.15.
pin indexmap@2.14.2 2.11.0

# Lockfile version: platform-tools' cargo cannot read v4. A COMPLETE v3 lock
# is preserved by every cargo in the tree; the encoding of registry deps is
# identical between v3 and v4, so the version line is the whole conversion.
if grep -q '^version = 4$' Cargo.lock; then
  sed -i 's/^version = 4$/version = 3/' Cargo.lock
  echo "toolchain-pin: Cargo.lock pinned at version 3"
fi
