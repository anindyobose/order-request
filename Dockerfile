FROM node:24-bookworm-slim AS dependencies
WORKDIR /app
RUN apt-get update \
    && apt-get install -y --no-install-recommends openssl \
    && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json ./
RUN npm ci

FROM dependencies AS builder
COPY . .
RUN npx prisma generate \
    && DATABASE_URL=postgresql://build:build@127.0.0.1:5432/build?schema=public npm run build

FROM node:24-bookworm-slim AS production
WORKDIR /app
ENV NODE_ENV=production
RUN apt-get update \
    && apt-get install -y --no-install-recommends openssl \
    && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json ./
COPY prisma ./prisma
RUN npm ci --omit=dev \
    && npx prisma generate \
    && npm cache clean --force
COPY scripts ./scripts

FROM production AS web
COPY --from=builder /app/.next ./.next
COPY --from=builder /app/public ./public
COPY next.config.ts tsconfig.json ./
RUN mkdir -p public/uploads .next/cache \
    && chown -R node:node public .next
EXPOSE 3000
USER node
CMD ["node", "scripts/web-server.mjs"]

FROM production AS worker
USER node
CMD ["node", "scripts/notification-worker.mjs"]
