#!/usr/bin/env bash
set -euo pipefail
export PATH="/home/vader/.local/share/solana/install/active_release/bin:/home/vader/.cargo/bin:$PATH"
cd /mnt/c/Users/HP/Desktop/crucible/crucible-contracts/solana
anchor build 2>&1 | tee /mnt/c/Users/HP/Desktop/crucible/anchor-build.log
echo "BUILD_EXIT_DONE"
