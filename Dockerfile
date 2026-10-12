FROM node:20-alpine AS base
WORKDIR /app

# Deps de build para better-sqlite3
RUN apk add --no-cache python3 make g++ sqlite-dev

COPY package*.json ./
RUN npm install --omit=dev

COPY src ./src
COPY public ./public

# Usuario no root
RUN addgroup -S app && adduser -S app -G app \
  && mkdir -p /app/data && chown -R app:app /app
USER app

ENV NODE_ENV=production
ENV BFF_PORT=10000
EXPOSE 10000

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD wget -qO- http://127.0.0.1:10000/api/health >/dev/null 2>&1 || exit 1

CMD ["node", "src/server.js"]
