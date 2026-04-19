# syntax=docker/dockerfile:1.7
# ─── Agent Federation — Production Dockerfile ───────────────────────────────
# Hedef: Kucuk, guvenli, hizli baslatan container (Fly.io icin optimize).
#
# Iki modda kullanilabilir:
#   1. Relay sunucusu (varsayilan): npx tsx relay-server.ts
#   2. Tam sunucu (dashboard + P2P): npx tsx start-server.ts
#
# Mod secimi: RELAY_MODE env var ile yapilir.
#   RELAY_MODE=true  → relay-server.ts calistirilir
#   RELAY_MODE=false → start-server.ts calistirilir

FROM node:20-alpine AS runtime

# Guvenlik: non-root user
RUN addgroup -S app && adduser -S app -G app

WORKDIR /app

# Sadece production dep'leri icin manifest kopyala
COPY --chown=app:app package.json package-lock.json* ./

# Production bagimliliklari + tsx (runtime TypeScript executor)
RUN npm ci --omit=dev --ignore-scripts \
 && npm cache clean --force

# Uygulama kaynagi
COPY --chown=app:app src/ ./src/
COPY --chown=app:app start-server.ts relay-server.ts tsconfig.json ./
COPY --chown=app:app ui/dashboard.html ui/dashboard.js ./ui/

# Runtime dizinleri
RUN mkdir -p /app/logs /app/.federation-sandbox \
 && chown -R app:app /app/logs /app/.federation-sandbox

USER app

# Fly.io internal_port ile eslesmeli
ENV PORT=8080 \
    HOST=0.0.0.0 \
    NODE_ENV=production \
    RELAY_MODE=true

EXPOSE 8080

# Health check — Fly.io'nun disaridan yaptigi check'e ek olarak
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "require('http').get('http://127.0.0.1:' + (process.env.PORT || 8080) + '/health', r => process.exit(r.statusCode === 200 ? 0 : 1)).on('error', () => process.exit(1))"

# Entrypoint: RELAY_MODE'a gore hangi sunucuyu baslat
CMD ["sh", "-c", "if [ \"$RELAY_MODE\" = \"true\" ]; then npx tsx relay-server.ts; else npx tsx start-server.ts; fi"]
