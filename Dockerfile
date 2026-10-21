# Multi-stage production Dockerfile for IndexDoctor
# Target platform: Google Cloud Run (Node 24 Active LTS, non-root)

# Stage 1: Builder
FROM node:25-slim AS builder

WORKDIR /app

# Install dependencies needed for compilation
COPY package.json package-lock.json .npmrc ./
RUN npm ci

# Copy build configuration and source files
COPY tsconfig*.json vite.config.ts ./
COPY src/ ./src/

# Build production bundles
RUN npm run build

# Stage 2: Production runner
FROM node:25-slim AS runner

WORKDIR /app

ENV NODE_ENV=production
ENV PORT=8080

# Install runtime dependencies only
COPY package.json package-lock.json .npmrc ./
RUN npm ci --omit=dev

# Copy compiled bundles from builder
COPY --from=builder /app/dist ./dist

# Non-root execution for container security
USER node

EXPOSE 8080

CMD ["node", "dist/server/main.js"]
