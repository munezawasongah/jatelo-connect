# Builds the operator dashboard and serves it with Caddy (HTTPS, reverse proxy).
FROM node:22-alpine AS dashboard
WORKDIR /build
COPY dashboard/package.json dashboard/package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY dashboard/ ./
RUN npm run build

FROM caddy:2-alpine
COPY caddy/Caddyfile /etc/caddy/Caddyfile
COPY --from=dashboard /build/dist /srv/dashboard
