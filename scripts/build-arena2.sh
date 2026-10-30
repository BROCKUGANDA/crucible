#!/usr/bin/env bash
export PATH="/home/vader/.local/share/solana/install/active_release/bin:/home/vader/.cargo/bin:$PATH"
cd /mnt/c/Users/HP/Desktop/crucible/crucible-contracts/solana
cargo build-sbf -- -p crucible-arena > /mnt/c/Users/HP/Desktop/crucible/build-arena2.log 2>&1
echo "EXIT_CODE=$?" >> /mnt/c/Users/HP/Desktop/crucible/build-arena2.log
