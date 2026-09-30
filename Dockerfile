# Instagib Arena — multi-stage image.
#
# Build stage: install everything (incl. dev deps) and produce the client
# bundle in dist/. Runtime stage: a lean image with only production deps
# (tsx remains because the server runs `node --import tsx server/index.ts`),
# the built client, the server, and the THREE-free shared game modules.

# --- build: compile the client bundle ---------------------------------------
FROM node:24-trixie-slim AS build
WORKDIR /app
# Install deps first so this layer caches across source-only changes.
COPY package*.json ./
RUN npm ci
COPY . .
RUN npm run build

# --- runtime: serve dist/ + the game/stats server ---------------------------
FROM node:24-trixie-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production \
    PORT=8787
# Production deps only. better-sqlite3 pulls a prebuilt linux/Node 24 binary
# (prebuild-install), so no C/C++ toolchain is needed here.
COPY package*.json ./
RUN apt-get update && apt-get install -y --no-install-recommends gosu \
    && apt-get upgrade -y && rm -rf /var/lib/apt/lists/*
RUN npm ci --omit=dev && npm cache clean --force \
    && rm -rf /usr/local/lib/node_modules/npm /opt/yarn* \
    && rm -f /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/yarn /usr/local/bin/yarnpkg
# Built client, the server, and the shared game modules the server imports at
# runtime (src/game/{constants,arena-data,types}.ts). tsconfig* lets tsx resolve
# the project's module settings.
COPY --from=build /app/dist ./dist
COPY server ./server
COPY src/game ./src/game
COPY tsconfig*.json ./
COPY scripts/docker-entrypoint.sh /usr/local/bin/instagib-entrypoint
RUN chmod 755 /usr/local/bin/instagib-entrypoint
ENTRYPOINT ["instagib-entrypoint"]
EXPOSE 8787
# The SQLite stats DB lives at /app/data — mount a persistent volume there so it
# survives container churn. On Railway, attach a Railway Volume at /app/data
# (the platform rejects a Dockerfile `VOLUME`); for plain Docker, bind-mount it:
# `docker run -v "$PWD/data:/app/data" …`.
CMD ["node", "--import", "tsx", "server/index.ts"]
