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
    HOSTNAME=0.0.0.0
# `node` user (uid 1000) ships with the image; run unprivileged.
COPY --from=build --chown=node:node /app/public ./public
COPY --from=build --chown=node:node /app/.next/standalone ./
COPY --from=build --chown=node:node /app/.next/static ./.next/static
USER node
EXPOSE 3000
CMD ["node", "server.js"]
