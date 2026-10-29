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
# cidstore is named as a workspace dependency of @crucible/argus, so `npm ci` here resolves it
# whether or not the api ever imports it: an omitted manifest makes the install ask the registry for
# a package that exists only in this repository. `node scripts/workspace-coverage-gate.mjs` in the
# TypeScript job now fails on that omission rather than the deploy discovering it.
COPY packages/cidstore/package.json packages/cidstore/
COPY packages/crypto/package.json packages/crypto/
COPY packages/datasets/package.json packages/datasets/
COPY packages/eval/package.json packages/eval/
COPY packages/registry/package.json packages/registry/
COPY packages/forge-runner/package.json packages/forge-runner/
COPY packages/frame/package.json packages/frame/
COPY packages/forge-runner/package.json packages/forge-runner/
COPY packages/indexer/package.json packages/indexer/
COPY packages/smith-sdk/package.json packages/smith-sdk/
COPY packages/warden/package.json packages/warden/
COPY grader/package.json grader/
COPY packages/site-index/package.json packages/site-index/
COPY apps/api/package.json apps/api/
COPY apps/keeper/package.json apps/keeper/
COPY apps/juror/package.json apps/juror/
COPY apps/funder/package.json apps/funder/
COPY apps/web/package.json apps/web/
RUN npm ci --ignore-scripts

COPY . .
RUN npm run build:libs \
  && npm run build --workspace @crucible/api \
  && npm prune --omit=dev --ignore-scripts

FROM node:22-alpine AS runner
WORKDIR /repo
ENV NODE_ENV=production \
    PORT=8787

COPY --from=build /repo/package.json ./package.json
COPY --from=build /repo/node_modules ./node_modules
COPY --from=build /repo/packages ./packages
COPY --from=build /repo/apps/api/package.json ./apps/api/package.json
COPY --from=build /repo/apps/api/dist ./apps/api/dist
COPY apps/api/docker-entrypoint.sh /usr/local/bin/crucible-api-entrypoint.sh

EXPOSE 8787
ENTRYPOINT ["/usr/local/bin/crucible-api-entrypoint.sh"]
