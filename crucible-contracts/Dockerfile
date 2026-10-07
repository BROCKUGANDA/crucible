# syntax=docker/dockerfile:1
# Build context is the repository root, so the COPY paths are repo-relative.
FROM ghcr.io/foundry-rs/foundry:latest

WORKDIR /contracts
COPY crucible-contracts/foundry.toml ./
COPY crucible-contracts/contracts ./contracts
COPY crucible-contracts/script ./script
COPY crucible-contracts/test ./test
COPY crucible-contracts/lib ./lib
COPY crucible-contracts/docker-seed.sh /usr/local/bin/docker-seed.sh

# Compile at build time so every seed run reuses this cache instead of recompiling.
RUN forge build

# The deployed-addresses volume mounts here; the foundry image's default USER cannot
# write under /run, so create the mount point as root and leave it world-writable.
USER root
RUN mkdir -p /run/crucible && chmod 0777 /run/crucible

ENTRYPOINT ["/usr/local/bin/docker-seed.sh"]
