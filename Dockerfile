# GanttSmart for Google Cloud Run: one image serving the React build (VITE_BACKEND=gcp) and the
# Node API server. Configuration (env vars, secrets) is supplied by Cloud Run at runtime, never
# baked into the image. See docs/gcp-deployment.md.

# ---- Build stage: frontend + server ----
FROM node:22-slim AS build
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY . .
RUN VITE_BACKEND=gcp npm run build \
  && npm run build:server

# ---- Runtime stage: production dependencies + built output only ----
FROM node:22-slim
WORKDIR /app

ENV NODE_ENV=production \
    PORT=8080 \
    STATIC_DIR=dist

COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY --from=build /app/dist ./dist
COPY --from=build /app/server-dist ./server-dist

# The official Node image ships an unprivileged "node" user. App files stay root-owned, so the
# running process can read but not modify them.
USER node
EXPOSE 8080
CMD ["node", "server-dist/index.js"]
