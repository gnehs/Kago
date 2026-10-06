# syntax=docker/dockerfile:1

# Build stages run on the builder's native platform so multi-arch builds skip
# QEMU emulation. This is safe because the production deps are pure JS; if a
# native addon is ever added, drop --platform here.
FROM --platform=$BUILDPLATFORM node:24-bookworm-slim AS base
WORKDIR /app
ENV PNPM_HOME="/pnpm"
ENV PATH="$PNPM_HOME:$PATH"
RUN corepack enable

FROM base AS deps
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY apps/server/package.json apps/server/package.json
COPY apps/web/package.json apps/web/package.json
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store \
  pnpm install --frozen-lockfile

FROM deps AS build
COPY . .
RUN pnpm build
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store \
  pnpm --filter @kago/server deploy --prod /prod

FROM node:24-bookworm-slim AS runtime
WORKDIR /app
RUN apt-get update \
  && apt-get install -y --no-install-recommends rsync attr ffmpeg \
  && rm -rf /var/lib/apt/lists/* \
  && groupmod -n kago node \
  && usermod -l kago -d /app -s /usr/sbin/nologin node \
  && mkdir -p /data /app-data \
  && chown -R kago:kago /data /app-data
ENV NODE_ENV=production
ENV DATA_DIR=/data
ENV APP_DATA_DIR=/app-data
ENV WEB_DIST_DIR=/app/apps/web/dist
ENV PORT=8080
COPY --from=build --chown=kago:kago /prod ./
COPY --from=build --chown=kago:kago /app/apps/web/dist ./apps/web/dist
COPY --chmod=755 docker/entrypoint.sh /usr/local/bin/kago-entrypoint
EXPOSE 8080
# The entrypoint starts as root only to drop to PUID:PGID (default 1000:1000, the kago user).
ENV PUID=1000
ENV PGID=1000
ENV UMASK=022
ENTRYPOINT ["kago-entrypoint"]
CMD ["node", "dist/main.js"]
