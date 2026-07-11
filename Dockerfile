# syntax=docker/dockerfile:1
# Multi-stage build for the Next.js standalone server. Works on arm64 (Oracle
# Ampere A1) and amd64 — Debian slim avoids musl/native-prebuild issues that
# Alpine can hit with @tailwindcss/oxide and @next/swc.

FROM node:22-bookworm-slim AS base
WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1

# --- Dependencies (cached unless lockfile changes) ---
FROM base AS deps
COPY package.json package-lock.json ./
RUN npm ci

# --- Build ---
FROM base AS build
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN npm run build

# --- Runtime (minimal) ---
FROM base AS runner
ENV NODE_ENV=production \
    PORT=3000 \
    HOSTNAME=0.0.0.0 \
    HEDGE_DB_PATH=/data/hedge.db
# `node` user (uid 1000) ships with the image; run unprivileged.
COPY --from=build --chown=node:node /app/public ./public
COPY --from=build --chown=node:node /app/.next/standalone ./
COPY --from=build --chown=node:node /app/.next/static ./.next/static
# Default HedgeScope config. Compose bind-mounts over this read-only so the
# universe and thresholds can be edited without a rebuild; baking a copy in
# keeps a plain `docker run` working too.
COPY --chown=node:node hedge.config.yaml ./hedge.config.yaml
# Mountpoint for the hedge-data volume. Created here (and owned by `node`) so
# the named volume inherits the right ownership on first attach — otherwise it
# lands as root-owned and the unprivileged server cannot open the database.
#
# NB: HedgeScope stores its IV history with Node's *built-in* `node:sqlite`, not
# `better-sqlite3`. That is deliberate: better-sqlite3 is a native addon and
# would drag python3/make/g++ into this build plus an arm64 prebuild to gamble
# on. The built-in needs none of it — hence no toolchain stage below.
RUN mkdir -p /data && chown node:node /data
VOLUME ["/data"]
USER node
EXPOSE 3000
CMD ["node", "server.js"]
