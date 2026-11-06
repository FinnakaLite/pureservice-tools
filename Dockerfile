# syntax=docker/dockerfile:1
# PureService bot. Node 24 runs the TypeScript sources directly (type stripping),
# so there is no build step. The only runtime dependency is luxon.
FROM node:24-slim

ENV NODE_ENV=production \
    BOT_DB_PATH=/app/data/bot.db \
    BOT_HEALTH_HOST=0.0.0.0 \
    BOT_HEALTH_PORT=8080

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY src ./src

# The SQLite database lives here. A named volume mounted on this path inherits
# the ownership below, so the unprivileged "node" user can write to it.
RUN mkdir -p /app/data && chown node:node /app/data
USER node
VOLUME ["/app/data"]

EXPOSE 8080

# /healthz returns 503 until the first successful poll, and whenever PureService is
# unreachable, writing is paused, or the circuit breaker is open.
HEALTHCHECK --interval=30s --timeout=5s --start-period=60s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:' + (process.env.BOT_HEALTH_PORT || 8080) + '/healthz').then(r => process.exit(r.ok ? 0 : 1), () => process.exit(1))"]

# node:sqlite still prints an ExperimentalWarning on Node 24; it is harmless.
CMD ["node", "--disable-warning=ExperimentalWarning", "src/main.ts"]
