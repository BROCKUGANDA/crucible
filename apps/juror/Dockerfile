# syntax=docker/dockerfile:1
# Build context is the repository root (npm workspaces must resolve across packages).
FROM node:22-alpine AS build
WORKDIR /repo

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
COPY packages/forge-runner/package.json packages/forge-runner/
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
  && npm run build --workspace @crucible/juror \
  && npm prune --omit=dev --ignore-scripts

FROM node:22-alpine AS runner
WORKDIR /repo
ENV NODE_ENV=production \
    PORT=8790

COPY --from=build /repo/package.json ./package.json
COPY --from=build /repo/node_modules ./node_modules
COPY --from=build /repo/packages ./packages
COPY --from=build /repo/apps/juror/package.json ./apps/juror/package.json
COPY --from=build /repo/apps/juror/dist ./apps/juror/dist

# The trial content and the pinning step, so the seat can serve a verdict against bytes it can
# actually read. A verifier that cannot fetch the spec abstains, and abstention is the honest answer
# — but on a fresh chain it is also an answer nobody wanted, because the demo's own trials commit to
# this repository's fixtures. The entrypoint therefore pins before it polls, in this container, from
# the files baked into the image: pin-then-post, with the pinning and the reading on the same side of
# the same digest.
#
# One writer per content directory. The disclosure log is an append-only hash chain, so two seats
# starting at once against one store would be two writers appending to it; the demo runs one, and
# the compose service says so where it mounts the volume.
COPY --from=build /repo/fixtures ./fixtures
COPY --from=build /repo/scripts/seed-content.mjs ./scripts/seed-content.mjs
# The other half of the pinning step: `seed-content.mjs --check`, which the entrypoint runs before
# it polls, reads both digests back out of this source file to prove the image's fixtures still
# match what the chain commits to. Without it the check answers "SeedContent.sol is missing or does
# not carry both constants" and the seat dies at start — which is why the copy sits next to the
# script it validates rather than in the app layer above.
COPY --from=build /repo/crucible-contracts/script/SeedContent.sol ./crucible-contracts/script/SeedContent.sol
COPY apps/juror/docker-entrypoint.sh /usr/local/bin/crucible-juror-entrypoint.sh

# The seat's durable memory lives here: a sealed vote and the salt that opens it. It is a volume
# rather than image state because a salt that cannot survive a `docker compose up -d` is a vote
# destroyed by a restart — `commitVote` will not accept a second commitment from this seat
# (CrucibleTrials.sol:559), so the seat would be mute on that dispute for the life of the chain.
#
# There is deliberately no `docker` CLI and no daemon socket in this image. The verifier re-runs the
# pinned suite in a sandbox, and a container that can ask the host daemon to start containers holds
# root on that host. On this machine the box also runs other projects, so the trade is not this
# service's to make silently: see the `juror` service in compose.yaml for what each option costs.
RUN mkdir -p /state /content && chmod 0777 /state /content

EXPOSE 8790
ENTRYPOINT ["/usr/local/bin/crucible-juror-entrypoint.sh"]
CMD ["node", "apps/juror/dist/main.js"]
