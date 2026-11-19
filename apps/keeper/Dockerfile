# syntax=docker/dockerfile:1
# Build context is the repository root (npm workspaces must resolve across packages).
FROM node:22-alpine AS build
WORKDIR /repo

COPY package.json package-lock.json ./
COPY crucible-contracts/package.json crucible-contracts/package.json
COPY packages/agent-security/package.json packages/agent-security/
COPY packages/argus/package.json packages/argus/
# See apps/api/Dockerfile: `npm ci` resolves the whole workspace set, and @crucible/argus names
# cidstore as a workspace dependency.
COPY packages/cidstore/package.json packages/cidstore/
COPY packages/crypto/package.json packages/crypto/
COPY packages/datasets/package.json packages/datasets/
COPY packages/eval/package.json packages/eval/
COPY packages/engrams/package.json packages/engrams/
COPY packages/registry/package.json packages/registry/
COPY packages/forge-runner/package.json packages/forge-runner/
COPY packages/forge-watch/package.json packages/forge-watch/
COPY packages/frame/package.json packages/frame/
COPY packages/arena-events/package.json packages/arena-events/
COPY packages/forge-runner/package.json packages/forge-runner/
COPY packages/forge-watch/package.json packages/forge-watch/
COPY packages/indexer/package.json packages/indexer/
COPY packages/smith-sdk/package.json packages/smith-sdk/
COPY packages/warden/package.json packages/warden/
COPY packages/stamp-core/package.json packages/stamp-core/
COPY packages/stamp-solana/package.json packages/stamp-solana/
COPY grader/package.json grader/
COPY packages/site-index/package.json packages/site-index/
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/
COPY apps/keeper/package.json apps/keeper/
COPY apps/juror/package.json apps/juror/
COPY apps/funder/package.json apps/funder/
COPY apps/fork-host/package.json apps/fork-host/
RUN npm ci --ignore-scripts

COPY . .
# See apps/api/Dockerfile: the workspace install retains some development tools
# after pruning. The keeper runs compiled Node output and does not need TypeScript's
# Go-built compiler at runtime.
RUN npm run build:libs \
  && npm run build --workspace @crucible/keeper \
  && npm prune --omit=dev --ignore-scripts \
  && rm -rf node_modules/typescript node_modules/@typescript/typescript-linux-x64 \
  && rm -rf apps/web \
  && find node_modules -type d \( -name esbuild -o -name "@esbuild" -o -name vite -o -name vitest -o -name "@vitest" -o -name tsx \) -prune -exec rm -rf {} \;

FROM node:22-alpine AS runner
# npm ships vulnerable transitive deps inside its own bundle (ip-address, brace-expansion, pacote, sigstore), and the base image pins npm 10.x. Upgrade npm in the runtime image: the server never runs the npm CLI, but Trivy scans the whole filesystem, and the gate refuses the image while its bundled tree is vulnerable. Version pinned; re-measure when the base image moves.
RUN npm install -g npm@12.2.2

WORKDIR /repo
ENV NODE_ENV=production \
    PORT=8789

COPY --from=build /repo/package.json ./package.json
COPY --from=build /repo/node_modules ./node_modules
COPY --from=build /repo/packages ./packages
COPY --from=build /repo/apps/keeper/package.json ./apps/keeper/package.json
COPY --from=build /repo/apps/keeper/dist ./apps/keeper/dist
COPY --from=build /repo/apps/keeper/docker-entrypoint.sh ./apps/keeper/docker-entrypoint.sh
RUN chmod +x ./apps/keeper/docker-entrypoint.sh

# Run as a non-root user. The entrypoint only execs node, so no privilege is
# needed at runtime; the trace volume is created node-owned on first use.
RUN mkdir -p /trace && chown -R node:node /repo /trace
USER node

EXPOSE 8789
ENTRYPOINT ["./apps/keeper/docker-entrypoint.sh"]
