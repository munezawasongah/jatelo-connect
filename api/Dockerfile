FROM node:22-alpine
RUN apk add --no-cache wireguard-tools tini
WORKDIR /app/api
COPY api/package.json api/package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY api/src ./src
COPY db /app/db
ENV NODE_ENV=production MIGRATIONS_DIR=/app/db/migrations
USER root
ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "src/server.js"]
