# syntax=docker/dockerfile:1.6

# ---- Stage 1: Build the static bundle ------------------------------------
FROM node:20-alpine AS builder
WORKDIR /app

# Shared data/fixtures symlink lives at the repo root; we COPY it in since the
# dashboard imports it via the `../../../data/fixtures/...` raw Vite import.
COPY dashboard/package.json dashboard/package-lock.json* dashboard/tsconfig.json dashboard/tsconfig.node.json dashboard/vite.config.ts dashboard/tailwind.config.js dashboard/postcss.config.js dashboard/index.html ./
RUN npm install --no-audit --no-fund

COPY dashboard/src ./src
RUN mkdir -p ./public && cp -r dashboard/public/* ./public/ 2>/dev/null || true
COPY dashboard/.env.example ./

# Build expects fixture data to exist at the path the source imports from. We
# COPY the sibling folder to keep the multi-stage build hermetic (no build
# context leakage from parent in a monorepo build).
ARG FIXTURES_SRC=../data/fixtures
COPY data /data

# If VITE_API_BASE is set at build time it's baked into the static output for
# standalone static hosting (Vercel / Netlify). Otherwise fallback = '/api'.
ARG VITE_API_BASE
RUN if [ -n "$VITE_API_BASE" ]; then export VITE_API_BASE="$VITE_API_BASE"; fi && \
    npm run build

# ---- Stage 2: nginx for static delivery ----------------------------------
FROM nginx:1.27-alpine AS runner

# Dashboard reachable at port 80 inside the compose network; expose 8080 out.
ENV NGINX_PORT=8080
COPY --from=builder /app/dist /usr/share/nginx/html

# Ship a tiny nginx config that:
#   1. Serves the Vite SPA on 0.0.0.0:8080
#   2. Proxies /api/* → http://api:3001/v1/*
RUN printf 'server {\n\
    listen 8080 default_server;\n\
    server_name _;\n\
    root /usr/share/nginx/html;\n\
    index index.html;\n\
    client_max_body_size 20m;\n\
    location /api/ {\n\
        proxy_pass         http://api:3001/v1/;\n\
        proxy_http_version 1.1;\n\
        proxy_set_header   Host              $host;\n\
        proxy_set_header   X-Real-IP         $remote_addr;\n\
        proxy_set_header   X-Forwarded-For   $proxy_add_x_forwarded_for;\n\
        proxy_set_header   X-Forwarded-Proto $scheme;\n\
        proxy_read_timeout 30s;\n\
    }\n\
    location / {\n\
        try_files $uri $uri/ /index.html;\n\
    }\n\
}\n' > /etc/nginx/conf.d/default.conf

EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
    CMD curl -fsS http://localhost:8080/ >/dev/null 2>&1 || exit 1

CMD ["nginx", "-g", "daemon off;"]
