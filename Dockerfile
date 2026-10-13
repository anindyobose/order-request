FROM node:24-bookworm-slim

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
RUN apt-get update -y && apt-get install -y --no-install-recommends openssl && rm -rf /var/lib/apt/lists/*
COPY . .
RUN npx prisma generate && npm run build
RUN mkdir -p public/uploads .next/cache && chown -R node:node public/uploads .next

ENV NODE_ENV=production
EXPOSE 3000
USER node
CMD ["sh", "-c", "npm run db:deploy && npm run start"]
