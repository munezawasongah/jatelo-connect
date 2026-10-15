#!/usr/bin/env bash
# Pull the latest code and rebuild. Run on the server: cd /opt/jatelo-connect && bash deploy/update.sh
set -euo pipefail
cd "$(dirname "$0")/.."
git pull --ff-only
docker compose up -d --build --remove-orphans
for i in $(seq 1 40); do
  curl -fsS http://127.0.0.1:8080/api/health >/dev/null 2>&1 && { echo "✓ Updated to $(git rev-parse --short HEAD), API healthy"; break; }
  sleep 3
  [ "$i" -eq 40 ] && { docker compose logs --tail 60 api; echo "✗ API not healthy"; exit 1; }
done
docker image prune -f >/dev/null
docker compose ps --format 'table {{.Service}}\t{{.Status}}'
