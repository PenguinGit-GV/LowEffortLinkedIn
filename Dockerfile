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

# exec makes node PID 1 once migrations finish. Without it, sh (and npm)
# sit between the platform and the app, and neither forwards SIGTERM — so
# index.js's graceful-shutdown handler never ran on a redeploy/stop and the
# process was SIGKILLed mid-flight at the end of the grace period.
CMD ["sh", "-c", "npm run migrate && exec node src/index.js"]
