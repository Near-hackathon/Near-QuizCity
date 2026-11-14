# syntax=docker/dockerfile:1.7

# Quiz City API image.
#
# The build context is the repository root because the API imports the local
# workspace packages @quiz-city/protocol and @quiz-city/world-data.
#
#   docker build -f server/Dockerfile .
#
# Only the API workspace is installed; the web app and contract sources are
# excluded by .dockerignore.

FROM node:20.20-bookworm-slim AS deps
WORKDIR /app
ENV NPM_CONFIG_FUND=false \
    NPM_CONFIG_UPDATE_NOTIFIER=false
COPY package.json package-lock.json ./
COPY server/package.json server/
COPY packages/protocol/package.json packages/protocol/
COPY packages/world-data/package.json packages/world-data/
# The API executes TypeScript directly through tsx, so tsx is a runtime
# dependency. --ignore-scripts skips the near-sandbox test binary download.
RUN npm ci --workspace=server --ignore-scripts --no-audit --no-fund

FROM node:20.20-bookworm-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=8787
COPY --from=deps --chown=node:node /app/node_modules ./node_modules
COPY --from=deps --chown=node:node /app/server/node_modules ./server/node_modules
COPY --chown=node:node package.json package-lock.json ./
COPY --chown=node:node server/package.json server/tsconfig.json ./server/
COPY --chown=node:node server/src ./server/src
COPY --chown=node:node server/scripts ./server/scripts
COPY --chown=node:node server/db ./server/db
COPY --chown=node:node packages/protocol/package.json packages/protocol/package.json
COPY --chown=node:node packages/protocol/src ./packages/protocol/src
COPY --chown=node:node packages/world-data/package.json packages/world-data/package.json
COPY --chown=node:node packages/world-data/src ./packages/world-data/src
USER node
EXPOSE 8787
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:' + (process.env.PORT || '8787') + '/health/live').then((r) => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"
CMD ["node", "--import", "tsx", "server/src/index.ts"]
