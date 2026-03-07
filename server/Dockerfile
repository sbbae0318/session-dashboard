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

# Install backend dependencies
COPY package*.json ./
RUN npm ci

# Run tests FIRST — build gate
COPY tsconfig.json ./
COPY src/ ./src/
RUN npm test

# Build TypeScript
RUN npm run build

# ── Stage 3: Production ──
FROM node:20-alpine
WORKDIR /app

# Copy backend build artifacts and install production deps
COPY --from=backend-builder /app/package*.json ./
COPY --from=backend-builder /app/dist/ ./dist/
RUN npm ci --only=production && npm cache clean --force

# Copy frontend build into dist/public/ (where Fastify static serves from)
COPY --from=frontend-builder /app/dist/public/ ./dist/public/

# Non-root user for security
RUN addgroup -g 1001 -S nodejs && \
    adduser -S nodejs -u 1001
USER nodejs

EXPOSE 3097

# Health check
HEALTHCHECK --interval=30s --timeout=10s --start-period=10s --retries=3 \
  CMD wget -q --spider http://127.0.0.1:3097/health || exit 1

CMD ["node", "dist/cli.js"]
