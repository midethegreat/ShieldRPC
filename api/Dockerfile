# syntax=docker/dockerfile:1.6

# ---- Stage 1: deps + build -----------------------------------------------
FROM node:20-alpine AS builder
WORKDIR /app

# Install only prod deps first so layer is cacheable
COPY package.json package-lock.json* tsconfig.json ./
RUN npm install --no-audit --no-fund

# Copy source and build
COPY src ./src
COPY sql ./sql
COPY scripts ./scripts
RUN npx tsc -p tsconfig.json

# ---- Stage 2: slim runtime ----------------------------------------------
FROM node:20-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production \
    PORT=3001 \
    TZ=UTC

# Re-install with --omit=dev to get a slim image
COPY package.json package-lock.json* ./
RUN npm install --omit=dev --no-audit --no-fund && npm cache clean --force

# Copy compiled JS from builder + sql fixtures
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/sql ./sql
COPY --from=builder /app/scripts ./scripts
COPY .env.example ./

EXPOSE 3001
CMD ["node", "dist/index.js"]
