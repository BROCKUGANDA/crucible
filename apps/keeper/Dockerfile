# syntax=docker/dockerfile:1
# Build context is the repository root (npm workspaces must resolve across packages).
FROM node:22-alpine AS build
WORKDIR /repo

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
COPY apps/keeper/package.json apps/keeper/
RUN npm ci --ignore-scripts

COPY . .
RUN npm run build:libs \
  && npm run build --workspace @crucible/keeper \
  && npm prune --omit=dev --ignore-scripts

FROM node:22-alpine AS runner
WORKDIR /repo
ENV NODE_ENV=production \
    PORT=8789

COPY --from=build /repo/package.json ./package.json
COPY --from=build /repo/node_modules ./node_modules
COPY --from=build /repo/packages ./packages
COPY --from=build /repo/apps/keeper/package.json ./apps/keeper/package.json
COPY --from=build /repo/apps/keeper/dist ./apps/keeper/dist

EXPOSE 8789
CMD ["node", "apps/keeper/dist/main.js"]
