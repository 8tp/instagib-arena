# Instagib Arena — multi-stage image.
#
# Build stage: install everything (incl. dev deps) and produce the client
# bundle in dist/. Runtime stage: a lean image with only production deps
# (tsx survives the prune because the server runs `tsx server/index.ts`),
# the built client, the server, and the THREE-free shared game modules.

# --- build: compile the client bundle ---------------------------------------
FROM node:20.19-bookworm-slim AS build
WORKDIR /app
# Install deps first so this layer caches across source-only changes.
COPY package*.json ./
RUN npm ci
COPY . .
RUN npm run build

# --- runtime: serve dist/ + the game/stats server ---------------------------
FROM node:20.19-bookworm-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production \
    PORT=8787
# Production deps only. better-sqlite3 pulls a prebuilt linux/Node 20 binary
# (prebuild-install), so no C/C++ toolchain is needed here.
COPY package*.json ./
RUN npm ci --omit=dev
# Built client, the server, and the shared game modules the server imports at
# runtime (src/game/{constants,arena-data,types}.ts). tsconfig* lets tsx resolve
# the project's module settings.
COPY --from=build /app/dist ./dist
COPY server ./server
COPY src/game ./src/game
COPY tsconfig*.json ./
EXPOSE 8787
# The SQLite stats DB lives at /app/data — mount a persistent volume there so it
# survives container churn. On Railway, attach a Railway Volume at /app/data
# (the platform rejects a Dockerfile `VOLUME`); for plain Docker, bind-mount it:
# `docker run -v "$PWD/data:/app/data" …`.
CMD ["npm", "start"]
