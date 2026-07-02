# Production image for Railway (or any container host).
# Migrations run at container start — knex migrate:latest is idempotent and
# this schema is tiny, so boot-time migration beats coordinating a separate
# release step for a single-service app.

FROM node:22-alpine

WORKDIR /app

ENV NODE_ENV=production

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY knexfile.js ./
COPY src ./src

USER node

EXPOSE 3000

CMD ["sh", "-c", "npm run migrate && npm start"]
