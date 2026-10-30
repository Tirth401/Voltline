# One image for every Voltline process (D-036): gateway, api, charging controller, settlement, the
# migrator, and the simulator that runs as a Job inside the cluster. Node 24 runs the TypeScript
# sources directly (D-003), so the image holds the sources and the production dependencies, not a
# build output. Build from the repository root:
#
#   docker build -f deploy/Dockerfile -t voltline:dev .
#
# The base image is pinned to an exact version and digest, like every image we run (D-015).
ARG NODE_IMAGE=node:24.15.0-alpine3.23@sha256:d1b3b4da11eefd5941e7f0b9cf17783fc99d9c6fc34884a665f40a06dbdfc94f

FROM ${NODE_IMAGE} AS dependencies
RUN npm install --global pnpm@12.16.1
WORKDIR /app
# The lockfile alone decides what gets downloaded, so this layer is cached until it changes.
COPY pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm fetch --prod
COPY . .
RUN pnpm install --offline --frozen-lockfile --prod

FROM ${NODE_IMAGE}
# tini runs as process 1: it passes SIGTERM on to Node and reaps zombies. Node itself is then an
# ordinary process, which also lets the chaos driver SIGKILL it from inside the container: the
# kernel ignores SIGKILL sent to a namespace's process 1 from inside that namespace.
RUN apk add --no-cache tini
WORKDIR /app
COPY --from=dependencies /app /app
USER node
ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "services/gateway/src/main.ts"]
