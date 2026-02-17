# Hydra Orchestrator Dockerfile
#
# Multi-stage build for smaller, more secure image

# Build stage
FROM node:22-alpine AS builder

WORKDIR /app

# Copy package files
COPY package*.json ./

# Install dependencies
RUN npm ci --only=production=false

# Copy source
COPY tsconfig.json ./
COPY src/ ./src/

# Build TypeScript
RUN npm run build

# Prune dev dependencies
RUN npm prune --production

# Production stage
FROM node:22-alpine AS production

# Security: Create non-root user
RUN addgroup -g 1001 hydra && \
    adduser -u 1001 -G hydra -s /bin/sh -D hydra

WORKDIR /app

# Install curl for healthcheck and docker CLI for container spawning
RUN apk add --no-cache curl docker-cli

# Copy built application
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/package.json ./

# Copy additional files needed at runtime
COPY container/ ./container/
COPY groups/ ./groups/
COPY config-examples/ ./config-examples/

# Create directories for runtime data
RUN mkdir -p data store logs && \
    chown -R hydra:hydra /app

# Switch to non-root user
USER hydra

# Environment
ENV NODE_ENV=production
ENV HYDRA_API_PORT=3340

# Expose API port
EXPOSE 3340

# Health check
HEALTHCHECK --interval=30s --timeout=10s --start-period=10s --retries=3 \
    CMD curl -f http://localhost:3340/api/health || exit 1

# Start orchestrator
CMD ["node", "dist/index.js"]
