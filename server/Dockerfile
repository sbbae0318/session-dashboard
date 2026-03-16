# Session Dashboard
# 3-stage build: frontend (Svelte) + backend (TypeScript) + production

# ── Stage 1: Frontend Builder ──
FROM node:20-alpine AS frontend-builder
WORKDIR /app/frontend

# Install frontend dependencies
COPY frontend/package*.json ./
RUN npm ci

# Build Svelte app (Vite outputs to dist/)
COPY frontend/ ./
RUN npm run build

# ── Stage 2: Backend Builder ──
FROM node:20-alpine AS backend-builder
WORKDIR /app

# Install build tools for native addons (better-sqlite3)
RUN apk add --no-cache python3 make g++

# Install backend dependencies (including native build)
COPY package*.json ./
RUN npm ci

# Run tests FIRST — build gate
COPY tsconfig.json ./
COPY src/ ./src/
RUN npm test

# Build TypeScript
RUN npm run build

# Prune dev dependencies — production node_modules ready
RUN npm prune --omit=dev

# ── Stage 3: Production ──
FROM node:20-alpine
WORKDIR /app

# Copy backend build artifacts and pre-built production node_modules
COPY --from=backend-builder /app/package*.json ./
COPY --from=backend-builder /app/dist/ ./dist/
COPY --from=backend-builder /app/node_modules/ ./node_modules/

# Copy frontend build into dist/public/ (where Fastify static serves from)
COPY --from=frontend-builder /app/dist/public/ ./dist/public/

# Non-root user for security
RUN addgroup -g 1001 -S nodejs && \
    adduser -S nodejs -u 1001 && \
    mkdir -p /app/data /app/memos && \
    chown nodejs:nodejs /app/data /app/memos
USER nodejs

# Use /tmp for lock file in Docker (prevents PID 1 restart loop)
ENV LOCK_FILE_PATH=/tmp/session-dashboard.lock

EXPOSE 3097

# Health check
HEALTHCHECK --interval=30s --timeout=10s --start-period=10s --retries=3 \
  CMD wget -q --spider http://127.0.0.1:3097/health || exit 1

CMD ["node", "dist/cli.js"]
