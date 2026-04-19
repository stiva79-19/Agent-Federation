# syntax=docker/dockerfile:1.7
# ─── Agent Federation — Relay Server Dockerfile ─────────────────────────────
# Minimal relay-only container. Dashboard (ui/) dahil edilmez — relay sunucusu
# sadece WebSocket mesaj iletimi yapar, statik dosya servis etmez.
#
# Kullanim:
#   docker build -t agent-federation-relay .
#   docker run -p 8080:8080 agent-federation-relay
#
# Render.com ve Fly.io ile uyumlu.

FROM node:20-alpine AS runtime

# Guvenlik: non-root user
RUN addgroup -S app && adduser -S app -G app

WORKDIR /app

# Sadece production dep'leri icin manifest kopyala
COPY --chown=app:app package.json package-lock.json* ./

# Production bagimliliklari + tsx (runtime TypeScript executor)
RUN npm ci --omit=dev --ignore-scripts \
 && npm cache clean --force

# Uygulama kaynagi — sadece relay icin gereken dosyalar
COPY --chown=app:app src/ ./src/
COPY --chown=app:app relay-server.ts tsconfig.json ./

# Runtime dizinleri
RUN mkdir -p /app/logs \
 && chown -R app:app /app/logs

USER app

ENV PORT=8080 \
    HOST=0.0.0.0 \
    NODE_ENV=production \
    RELAY_MODE=true

EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "require('http').get('http://127.0.0.1:' + (process.env.PORT || 8080) + '/health', r => process.exit(r.statusCode === 200 ? 0 : 1)).on('error', () => process.exit(1))"

CMD ["npx", "tsx", "relay-server.ts"]
