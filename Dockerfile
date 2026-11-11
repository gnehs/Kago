# syntax=docker/dockerfile:1

# Used in a FROM below, so it has to be declared ahead of the first one.
ARG RCLONE_VERSION=1.75.1

# Build stages run on the builder's native platform so multi-arch builds skip
# QEMU emulation. This is safe because nothing is compiled for the image there:
# the one production dep with a binary of its own, sharp, ships it prebuilt, and
# the deploy below fetches the one for the platform the image is for. If a native
# addon that has to be compiled is ever added, drop --platform here.
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
COPY patches patches
COPY apps/server/package.json apps/server/package.json
COPY apps/web/package.json apps/web/package.json
COPY packages/plugin-sdk/package.json packages/plugin-sdk/package.json
COPY plugins/splat-viewer/package.json plugins/splat-viewer/package.json
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store \
  pnpm install --frozen-lockfile

# The server's production node_modules, from the manifests alone: a commit that leaves
# the lockfile alone reuses this stage, and with it the image layer it becomes.
FROM deps AS prod-deps
# Set by BuildKit to the architecture the image is for: amd64 or arm64.
ARG TARGETARCH
# Node's name for amd64 is x64; the runtime image below is Debian, so glibc.
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store \
  pnpm --filter @kago/server deploy --prod --os=linux --libc=glibc \
    --cpu="$([ "$TARGETARCH" = amd64 ] && echo x64 || echo "$TARGETARCH")" /prod

FROM deps AS build
COPY . .
# The commit the image is built from, for Settings → About: .git is not in the build context, so it is handed in.
ARG KAGO_COMMIT
RUN pnpm build
# A plugin is shipped as what it built and the manifest that describes it; its dependencies are bundled into the build.
RUN for plugin in plugins/*/; do mkdir -p "/bundled/$plugin" && cp -R "$plugin/package.json" "$plugin/dist" "/bundled/$plugin"; done

# rclone is what reaches remote locations (SMB, SFTP, WebDAV, ...); it is one static binary.
FROM rclone/rclone:${RCLONE_VERSION} AS rclone

FROM node:24-bookworm-slim AS runtime
WORKDIR /app
# jellyfin-ffmpeg bundles what GPU transcoding needs (NVENC, the Intel media driver, VAAPI), unlike Debian's build.
RUN apt-get update \
  && apt-get install -y --no-install-recommends attr smbclient perl ca-certificates curl gnupg \
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
# What rarely changes comes first and in layers of its own, so an update pulls only the ones that did.
# --link keeps each layer from depending on the ones before it; it also has no /etc/passwd to
# look names up in, hence 1000:1000, the kago user.
COPY --link --from=rclone /usr/local/bin/rclone /usr/local/bin/rclone
COPY --link --from=prod-deps --chown=1000:1000 /prod ./
# The CJK fonts, pdf.js and the subtitle renderer are most of the web build and change only with their packages.
COPY --link --from=build --chown=1000:1000 /app/apps/web/dist/assets/*.ttf ./apps/web/dist/assets/
COPY --link --from=build --chown=1000:1000 /app/apps/web/dist/pdfjs ./apps/web/dist/pdfjs
COPY --link --from=build --chown=1000:1000 /app/apps/web/dist/libass ./apps/web/dist/libass
COPY --link LICENSE THIRD-PARTY-NOTICES ./
COPY --link --chmod=755 docker/entrypoint.sh /usr/local/bin/kago-entrypoint
COPY --link --from=build --chown=1000:1000 /app/apps/server/dist ./dist
COPY --link --from=build --chown=1000:1000 /bundled/plugins ./plugins
COPY --link --from=build --chown=1000:1000 --exclude=assets/*.ttf --exclude=pdfjs --exclude=libass /app/apps/web/dist ./apps/web/dist
EXPOSE 8080
# The entrypoint starts as root only to drop to PUID:PGID (default 1000:1000, the kago user).
ENV PUID=1000
ENV PGID=1000
ENV UMASK=022
ENTRYPOINT ["kago-entrypoint"]
CMD ["node", "dist/main.js"]
