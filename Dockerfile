# Used by Railway (detected automatically) and any Docker host.
FROM node:22-slim

ENV NODE_ENV=production
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY src ./src
COPY public ./public

# Data (SQLite database + photos) lives in RAILWAY_VOLUME_MOUNT_PATH when a
# Railway Volume is attached, otherwise DATA_DIR, otherwise /app/data.
# Runs as root so it can write to Railway volumes, which are mounted root-owned.
EXPOSE 3000
CMD ["node", "--disable-warning=ExperimentalWarning", "src/server.js"]
