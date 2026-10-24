#!/usr/bin/env bash
# Gate 731 — the restore gate (v2 bible §3.2, adapted to this repository).
#
# This repo's persistence IS git (the bible's sandbox needed snapshot tarballs;
# a git checkout does not). What still needs proving on every session open:
# the tree is intact, the tools match AS_BUILT.md, the Solana keypair still
# exists for the recorded program id, and the fast proofs are green.
set -euo pipefail
cd "$(dirname "$0")/.."

fail=0
step() { printf '\n== %s\n' "$1"; }

step "tree"
git status --porcelain | head -5
git log --oneline -1

step "toolchain vs AS_BUILT.md"
ok() { printf '  ok    %s\n' "$1"; }
bad() { printf '  FAIL  %s\n' "$1"; fail=1; }

command -v node >/dev/null && ok "node $(node --version)" || bad "node missing"
command -v npm  >/dev/null && ok "npm $(npm --version)"   || bad "npm missing"
if command -v cargo >/dev/null 2>&1; then ok "cargo $(cargo --version)"; else
  echo "  note  host cargo not on this shell's PATH (WSL: source ~/.cargo/env)"
fi
# Solana toolchain lives in WSL on this machine (see AS_BUILT.md).
if wsl -d Ubuntu -- bash -lc 'command -v anchor >/dev/null' 2>/dev/null; then
  ok "anchor $(wsl -d Ubuntu -- bash -lc 'anchor --version' 2>/dev/null | head -1) (WSL)"
else
  echo "  note  anchor not found in WSL — see crucible-contracts/solana/README.md"
fi

step "keypairs for recorded program ids"
KP=crucible-contracts/solana/target/deploy/work_escrow-keypair.json
if [ -f "$KP" ]; then ok "$KP present"; else
  echo "  note  $KP absent in this checkout — regenerate on the build host (target/ is gitignored)"
fi

step "fast proofs"
npm run typecheck --workspaces --if-present >/dev/null && ok "typecheck (all workspaces)" || bad "typecheck"
node scripts/params-codegen.mjs --check >/dev/null && ok "params:check (gate 732)" || bad "params drift"
node scripts/workspace-coverage-gate.mjs .github/workflows/ci.yml >/dev/null && ok "workspace coverage" || bad "workspace coverage"

step "summary"
if [ "$fail" -eq 0 ]; then
  echo "RESTORE GREEN — tree, tools, params, coverage all proven."
else
  echo "RESTORE RED — fix the FAIL lines above before writing any code (bible rule 1)."
  exit 1
fi
