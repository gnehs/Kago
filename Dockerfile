FROM node:24-bookworm-slim AS base
WORKDIR /app
ENV PNPM_HOME="/pnpm"
ENV PATH="$PNPM_HOME:$PATH"
RUN corepack enable

FROM base AS deps
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY apps/server/package.json apps/server/package.json
COPY apps/web/package.json apps/web/package.json
RUN pnpm install --frozen-lockfile

FROM deps AS build
COPY . .
RUN pnpm build
RUN pnpm --filter @kago/server deploy --prod /prod

FROM node:24-bookworm-slim AS runtime
WORKDIR /app
RUN apt-get update \
  && apt-get install -y --no-install-recommends rsync \
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
EXPOSE 8080
USER kago
CMD ["node", "dist/main.js"]
