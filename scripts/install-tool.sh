#!/usr/bin/env bash
#
# Install a CI build tool from its release tarball, and refuse it unless it hashes to
# the digest recorded here.
#
# Why a script rather than six copies of a curl line: the version and the digest are one
# fact about one artefact, and a value duplicated across workflow files drifts — the job
# that still passes is the one nobody notices. It is also the reason this file exists at
# all. Three steps here were named "install foundry (pinned tarball)" while the body piped
# the download straight into `tar` with no hash comparison, so the pin was the *version
# tag*: an immutable-looking URL that a re-uploaded asset, a mirror, or a compromised
# release would sail through. A name that claims a check the code does not run is the exact
# shape of a gate that cannot fail.
#
# The digests, and how each was obtained (2026-10-23):
#
#   foundry v1.8.5  computed on this machine from the download, and corroborated by
#                   GitHub's own published asset digest:
#                   `gh api repos/foundry-rs/foundry/releases/tags/v1.8.5`
#                   -> "sha256:6c66ffcc…ffb226", equal to the measured value.
#   gitleaks 8.24.0 measured on this machine only. GitHub's API returns `digest: null` for
#                   that asset, so there is nothing to corroborate it against; the value is
#                   first-contact trust, recorded here so the *next* download is compared to
#                   it. Re-derive with:
#                   curl -fsSL <url> -o f && sha256sum f
#
# To update either tool: download the new tarball, hash it, put the hash here, and let CI
# be the thing that proves the two agree. Do not paste a hash from a release note without
# re-measuring the asset it names.
#
# Usage: install-tool.sh <foundry|gitleaks> <destination-dir> [expected-sha256]
# The third argument overrides the table; it exists so the failure path can be tested
# without waiting for an attack.

set -euo pipefail

FOUNDRY_VERSION="v1.8.5"
FOUNDRY_SHA256="6c66ffcc55fa4249197721baa3098bc208014ea1d8aa04b2ed50ac6bccffb226"

GITLEAKS_VERSION="8.24.0"
GITLEAKS_SHA256="cb49b7de5ee986510fe8666ca0273a6cc15eb82571f2f14832c9e8920751f3a4"

tool="${1:-}"
dest="${2:-}"
expected="${3:-}"

if [ -z "$tool" ] || [ -z "$dest" ]; then
  echo "usage: install-tool.sh <foundry|gitleaks> <destination-dir> [expected-sha256]" >&2
  exit 2
fi

case "$tool" in
  foundry)
    url="https://github.com/foundry-rs/foundry/releases/download/${FOUNDRY_VERSION}/foundry_${FOUNDRY_VERSION}_linux_amd64.tar.gz"
    [ -n "$expected" ] || expected="$FOUNDRY_SHA256"
    ;;
  gitleaks)
    url="https://github.com/gitleaks/gitleaks/releases/download/v${GITLEAKS_VERSION}/gitleaks_${GITLEAKS_VERSION}_linux_x64.tar.gz"
    [ -n "$expected" ] || expected="$GITLEAKS_SHA256"
    ;;
  *)
    # An unknown name is a refusal, not a miss: fetching nothing and extracting nothing
    # would leave the job to fail later on a missing binary, which reads like a broken
    # runner rather than a typo in a workflow.
    echo "install-tool.sh: no tool named '$tool' is pinned here" >&2
    echo "pinned: foundry ${FOUNDRY_VERSION}, gitleaks ${GITLEAKS_VERSION}" >&2
    exit 2
    ;;
esac

# Per-job, per-step: the three jobs that need forge used to extract into /tmp together and
# raced each other over one `forge` path, which failed a different job on each run.
tmp="$(mktemp "${TMPDIR:-/tmp}/$tool-XXXXXX.tar.gz")"
trap 'rm -f "$tmp"' EXIT

mkdir -p "$dest"
curl -fsSL --retry 3 -o "$tmp" "$url"

# `--strict` so a malformed line is an error rather than a skipped check, and the pair is
# verified before anything is written into $dest — an unverified extraction is a tool that
# the rest of the job then runs, in place.
if ! printf '%s  %s\n' "$expected" "$tmp" | sha256sum --check --status --strict; then
  measured="$(sha256sum "$tmp" | cut -d' ' -f1)"
  echo "install-tool.sh: $tool download does NOT match its pinned digest" >&2
  echo "  url      $url" >&2
  echo "  expected $expected" >&2
  echo "  measured $measured" >&2
  echo "  Nothing was extracted into $dest. If the release asset was legitimately rebuilt," >&2
  echo "  re-measure it and update the digest in this file — do not delete the check." >&2
  exit 1
fi

tar xzf "$tmp" -C "$dest"
echo "$tool $expected verified and extracted into $dest" >&2
