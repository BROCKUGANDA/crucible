# syntax=docker/dockerfile:1
# Build context is the repository root (npm workspaces must resolve across packages).
FROM node:22-alpine AS build
WORKDIR /repo

# Install first with only manifests present, so dependency layers survive source edits.
# --ignore-scripts skips the root `prepare` (build:libs), which needs the sources that
# are copied in the next step; the libs are built explicitly after.
COPY package.json package-lock.json ./
COPY crucible-contracts/package.json crucible-contracts/package.json
COPY packages/agent-security/package.json packages/agent-security/
COPY packages/argus/package.json packages/argus/
COPY packages/forge-runner/package.json packages/forge-runner/
COPY packages/indexer/package.json packages/indexer/
COPY packages/smith-sdk/package.json packages/smith-sdk/
COPY packages/warden/package.json packages/warden/
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/
RUN npm ci --ignore-scripts

COPY . .
RUN npm run build:libs

# NEXT_PUBLIC_* are inlined into the client bundle at build time — the browser talks to
# the API directly, so these describe the host's published ports, not the compose
# network names. They arrive as build args from compose.
ARG NEXT_PUBLIC_API_URL
ARG NEXT_PUBLIC_CHAIN
ARG NEXT_PUBLIC_TRIALS_ADDRESS
ARG NEXT_PUBLIC_ALLOY_ADDRESS
ARG NEXT_PUBLIC_ANVIL_RPC
ARG NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID
ENV NEXT_PUBLIC_API_URL="$NEXT_PUBLIC_API_URL" \
    NEXT_PUBLIC_CHAIN="$NEXT_PUBLIC_CHAIN" \
    NEXT_PUBLIC_TRIALS_ADDRESS="$NEXT_PUBLIC_TRIALS_ADDRESS" \
    NEXT_PUBLIC_ALLOY_ADDRESS="$NEXT_PUBLIC_ALLOY_ADDRESS" \
    NEXT_PUBLIC_ANVIL_RPC="$NEXT_PUBLIC_ANVIL_RPC" \
    NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID="$NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID"

RUN npm run build --workspace @crucible/web

FROM node:22-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production \
    PORT=3000 \
    HOSTNAME=0.0.0.0

# `output: "standalone"` traces the server and only the modules it needs; with the
# monorepo tracing root, the standalone tree is repo-shaped, so the entry is
# apps/web/server.js relative to the tree root.
COPY --from=build /repo/apps/web/.next/standalone ./
COPY --from=build /repo/apps/web/.next/static ./apps/web/.next/static
COPY --from=build /repo/apps/web/public ./apps/web/public

EXPOSE 3000
CMD ["node", "apps/web/server.js"]
