# syntax=docker/dockerfile:1
# Build context is the repository root (npm workspaces must resolve across packages).
FROM node:22-alpine AS build
WORKDIR /repo

# Install first with only manifests present, so dependency layers survive source edits.
COPY package.json package-lock.json ./
COPY crucible-contracts/package.json crucible-contracts/package.json
COPY packages/agent-security/package.json packages/agent-security/
COPY packages/argus/package.json packages/argus/
COPY packages/cidstore/package.json packages/cidstore/
COPY packages/crypto/package.json packages/crypto/
COPY packages/datasets/package.json packages/datasets/
COPY packages/eval/package.json packages/eval/
COPY packages/registry/package.json packages/registry/
COPY packages/forge-runner/package.json packages/forge-runner/
COPY packages/frame/package.json packages/frame/
COPY packages/arena-events/package.json packages/arena-events/
COPY packages/indexer/package.json packages/indexer/
COPY packages/smith-sdk/package.json packages/smith-sdk/
COPY packages/warden/package.json packages/warden/
COPY grader/package.json grader/
COPY packages/site-index/package.json packages/site-index/
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/
COPY apps/keeper/package.json apps/keeper/
COPY apps/juror/package.json apps/juror/
COPY apps/funder/package.json apps/funder/
RUN npm ci --ignore-scripts

COPY . .
RUN npm run build:libs \
  && npm run build --workspace @crucible/funder \
  && npm prune --omit=dev --ignore-scripts

# slim, not alpine: the Coinbase CLI runs on glibc.
FROM node:22-slim AS runner
WORKDIR /repo
ENV NODE_ENV=production \
    FUNDER_HOST=0.0.0.0 \
    FUNDER_PORT=8788

# The funder uses the CDP CLI for both transfers and onramp sessions. It is installed in the
# image so a container with credentials can work; without credentials the process still starts
# and reports configured:false.
RUN npm install -g @coinbase/cdp-cli@2.0.126 --no-audit --no-fund

COPY --from=build /repo/package.json ./package.json
COPY --from=build /repo/node_modules ./node_modules
COPY --from=build /repo/packages ./packages
COPY --from=build /repo/apps/funder/package.json ./apps/funder/package.json
COPY --from=build /repo/apps/funder/dist ./apps/funder/dist
COPY apps/funder/docker-entrypoint.sh /usr/local/bin/crucible-funder-entrypoint.sh
RUN chmod +x /usr/local/bin/crucible-funder-entrypoint.sh

EXPOSE 8788
ENTRYPOINT ["/usr/local/bin/crucible-funder-entrypoint.sh"]
