# syntax=docker/dockerfile:1

# Used in a FROM below, so it has to be declared ahead of the first one.
ARG RCLONE_VERSION=1.75.1

# Build stages run on the builder's native platform so multi-arch builds skip
# QEMU emulation. This is safe because the production deps are pure JS; if a
# native addon is ever added, drop --platform here.
FROM --platform=$BUILDPLATFORM node:24-bookworm-slim AS base
WORKDIR /app
ENV PNPM_HOME="/pnpm"
ENV PATH="$PNPM_HOME/bin:$PATH"
# Keep in sync with "packageManager" in package.json.
ARG PNPM_VERSION=12.9.1
# `pnpm setup` (run by get-pnpm) needs to know which shell to configure.
RUN SHELL="$(which bash)" ENV="$HOME/.bashrc" npx --yes get-pnpm "$PNPM_VERSION"

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

# rclone is what reaches remote locations (SMB, SFTP, WebDAV, ...); it is one static binary.
FROM rclone/rclone:${RCLONE_VERSION} AS rclone

FROM node:24-bookworm-slim AS runtime
WORKDIR /app
# jellyfin-ffmpeg bundles what GPU transcoding needs (NVENC, the Intel media driver, VAAPI), unlike Debian's build.
RUN apt-get update \
  && apt-get install -y --no-install-recommends attr perl ca-certificates curl gnupg \
  && curl -fsSL https://repo.jellyfin.org/jellyfin_team.gpg.key | gpg --dearmor -o /usr/share/keyrings/jellyfin.gpg \
  && echo "deb [signed-by=/usr/share/keyrings/jellyfin.gpg arch=$(dpkg --print-architecture)] https://repo.jellyfin.org/debian bookworm main" > /etc/apt/sources.list.d/jellyfin.list \
  && apt-get update \
  && apt-get install -y --no-install-recommends jellyfin-ffmpeg8 \
  && apt-get purge -y --auto-remove curl gnupg \
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
ENV FFMPEG_PATH=/usr/lib/jellyfin-ffmpeg/ffmpeg
ENV FFPROBE_PATH=/usr/lib/jellyfin-ffmpeg/ffprobe
# Read by the NVIDIA container runtime: `video` is what exposes NVENC/NVDEC inside the container.
ENV NVIDIA_VISIBLE_DEVICES=all
ENV NVIDIA_DRIVER_CAPABILITIES=compute,video,utility
COPY --from=build --chown=kago:kago /prod ./
COPY --from=build --chown=kago:kago /app/apps/web/dist ./apps/web/dist
COPY --from=rclone /usr/local/bin/rclone /usr/local/bin/rclone
COPY LICENSE THIRD-PARTY-NOTICES ./
COPY --chmod=755 docker/entrypoint.sh /usr/local/bin/kago-entrypoint
EXPOSE 8080
# The entrypoint starts as root only to drop to PUID:PGID (default 1000:1000, the kago user).
ENV PUID=1000
ENV PGID=1000
ENV UMASK=022
ENTRYPOINT ["kago-entrypoint"]
CMD ["node", "dist/main.js"]
