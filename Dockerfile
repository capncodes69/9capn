# syntax=docker/dockerfile:1.7
#
# Multi-stage build for the gateway. The runtime image carries the Next.js
# standalone output plus the handful of packages that Next's file tracing cannot
# see, because they are loaded by path or by a dynamic specifier rather than a
# static import.
ARG NODE_IMAGE=node:22-alpine
ARG ALPINE_MIRROR=dl-cdn.alpinelinux.org
ARG NPM_REGISTRY=https://registry.npmjs.org/
ARG APP_VERSION=unknown

FROM ${NODE_IMAGE} AS base
ARG ALPINE_MIRROR
WORKDIR /app

# Alpine's own mirror by default. It is what a Fly remote builder reaches
# fastest; a regional mirror turns this single apk step into a multi-minute wait
# and the builder times out before the native deps are even installed. Override
# the build arg only for a network that genuinely needs a regional mirror.
RUN if [ "$ALPINE_MIRROR" != "dl-cdn.alpinelinux.org" ]; then \
      sed -i "s|dl-cdn.alpinelinux.org|${ALPINE_MIRROR}|g" /etc/apk/repositories; \
    fi

FROM base AS builder
ARG NPM_REGISTRY

RUN apk add --no-cache python3 make g++ linux-headers

COPY package.json ./
RUN --mount=type=cache,target=/root/.npm \
    npm install \
      --registry="${NPM_REGISTRY}" \
      --fetch-retries=5 \
      --fetch-retry-factor=2 \
      --fetch-retry-mintimeout=10000 \
      --fetch-retry-maxtimeout=120000 \
      --fetch-timeout=300000

COPY . ./
ENV NEXT_TELEMETRY_DISABLED=1
RUN npm run build

FROM ${NODE_IMAGE} AS runner
ARG ALPINE_MIRROR
ARG APP_VERSION
WORKDIR /app

RUN if [ "$ALPINE_MIRROR" != "dl-cdn.alpinelinux.org" ]; then \
      sed -i "s|dl-cdn.alpinelinux.org|${ALPINE_MIRROR}|g" /etc/apk/repositories; \
    fi

LABEL org.opencontainers.image.title="9router" \
      org.opencontainers.image.version="${APP_VERSION}"

ENV NODE_ENV=production
ENV PORT=20128
ENV HOSTNAME=0.0.0.0
ENV NEXT_TELEMETRY_DISABLED=1
ENV DATA_DIR=/app/data

COPY --from=builder /app/public ./public
COPY --from=builder /app/.next/static ./.next/static
COPY --from=builder /app/.next/standalone ./
COPY --from=builder /app/custom-server.js ./custom-server.js

# The MITM proxy is spawned as a separate `node src/mitm/server.js` process, so
# Next's tracing never sees it. It is the only reason the runtime image carries
# source at all: everything else the gateway executes is already bundled into
# .next/standalone, and adding the full tree here would only shadow it.
COPY --from=builder /app/src/mitm ./src/mitm
COPY --from=builder /app/src/shared/constants/mitmToolHosts.js ./src/shared/constants/mitmToolHosts.js

# Packages reached by a path or a runtime specifier, which tracing skips. Each
# line names the loader that needs it — dropping one fails silently at request
# time, not at boot:
#   node-forge      src/mitm/cert/rootCA.js, require() by path
#   node-machine-id src/mitm/manager.js, require() by path
#   next            fallback if tracing omits the server binary
#   sql.js          loads dist/sql-wasm.wasm by path; last-resort DB driver
COPY --from=builder /app/node_modules/node-forge ./node_modules/node-forge
COPY --from=builder /app/node_modules/node-machine-id ./node_modules/node-machine-id
COPY --from=builder /app/node_modules/next ./node_modules/next
COPY --from=builder /app/node_modules/sql.js ./node_modules/sql.js

RUN mkdir -p /app/data && chown -R node:node /app && \
  mkdir -p /app/data-home && chown node:node /app/data-home && \
  ln -sf /app/data-home /root/.9router 2>/dev/null || true

# su-exec drops privileges after chowning the mounted volume: a Fly volume is
# owned by root on first boot, and the node user must be able to write the DB.
RUN apk add --no-cache su-exec && \
  printf '#!/bin/sh\nchown -R node:node /app/data /app/data-home 2>/dev/null\nexec su-exec node "$@"\n' > /entrypoint.sh && \
  chmod +x /entrypoint.sh

EXPOSE 20128

ENTRYPOINT ["/entrypoint.sh"]
CMD ["node", "custom-server.js"]
