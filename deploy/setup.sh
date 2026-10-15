#!/usr/bin/env bash
# ────────────────────────────────────────────────────────────────────────────
#  Jatelo Connect — one-command server setup (fresh Ubuntu 24.04, run as root)
#
#    curl -fsSL <raw link to this file> -o setup.sh
#    DOMAIN=jateloconnect.com ADMIN_EMAIL=you@example.com \
#    GITHUB_TOKEN=github_pat_xxx GITHUB_REPO=munezawasongah/jatelo-connect \
#    bash setup.sh
#
#  Safe to run again: it keeps existing secrets and data, and updates the code.
# ────────────────────────────────────────────────────────────────────────────
set -euo pipefail

: "${DOMAIN:?Set DOMAIN, e.g. DOMAIN=jateloconnect.com}"
: "${ADMIN_EMAIL:?Set ADMIN_EMAIL (your Jatelo admin login)}"
GITHUB_REPO="${GITHUB_REPO:-munezawasongah/jatelo-connect}"
APP_DIR="${APP_DIR:-/opt/jatelo-connect}"
APP_HOST="${APP_HOST:-app.$DOMAIN}"
API_HOST="${API_HOST:-api.$DOMAIN}"
PORTAL_HOST="${PORTAL_HOST:-wifi.$DOMAIN}"
WG_PORT=51820

say()  { printf '\n\033[1;36m▶ %s\033[0m\n' "$*"; }
ok()   { printf '  \033[32m✓\033[0m %s\n' "$*"; }
warn() { printf '  \033[33m!\033[0m %s\n' "$*"; }
die()  { printf '\n\033[1;31m✗ %s\033[0m\n' "$*"; exit 1; }

[ "$(id -u)" -eq 0 ] || die "Run as root (sudo -i first)."
grep -q 'VERSION_ID="24.04"' /etc/os-release || warn "Tested on Ubuntu 24.04; continuing anyway."

# ── 1. System packages ──────────────────────────────────────────────────────
say "Installing system packages"
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq ca-certificates curl git ufw wireguard-tools fail2ban unattended-upgrades jq openssl >/dev/null
if ! command -v docker >/dev/null; then
  curl -fsSL https://get.docker.com | sh >/dev/null
fi
systemctl enable --now docker >/dev/null
dpkg-reconfigure -f noninteractive unattended-upgrades >/dev/null 2>&1 || true
timedatectl set-timezone Africa/Bujumbura || true
ok "Docker $(docker --version | awk '{print $3}' | tr -d ,), WireGuard, firewall tools"

# ── 2. Code ─────────────────────────────────────────────────────────────────
say "Fetching the code"
if [ -d "$APP_DIR/.git" ]; then
  git -C "$APP_DIR" pull --ff-only
else
  : "${GITHUB_TOKEN:?Set GITHUB_TOKEN (a read-only GitHub token for the private repo)}"
  git clone -q "https://x-access-token:${GITHUB_TOKEN}@github.com/${GITHUB_REPO}.git" "$APP_DIR"
  # Do not keep the token in the remote URL
  git -C "$APP_DIR" remote set-url origin "https://github.com/${GITHUB_REPO}.git"
fi
cd "$APP_DIR"
ok "Code in $APP_DIR ($(git rev-parse --short HEAD))"

# ── 3. Public IP ────────────────────────────────────────────────────────────
PUBLIC_IP="${PUBLIC_IP:-$(curl -fsS4 https://api.ipify.org || curl -fsS4 https://ifconfig.me)}"
[[ "$PUBLIC_IP" =~ ^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$ ]] || die "Could not detect the public IPv4 address. Set PUBLIC_IP=..."
ok "Public IP $PUBLIC_IP"

# ── 4. WireGuard hub (routers connect here) ─────────────────────────────────
say "Setting up the WireGuard hub (10.88.0.1)"
mkdir -p /etc/wireguard && chmod 700 /etc/wireguard
if [ ! -f /etc/wireguard/hub.key ]; then
  umask 077; wg genkey > /etc/wireguard/hub.key; umask 022
fi
wg pubkey < /etc/wireguard/hub.key > /etc/wireguard/hub.pub
HUB_PUB="$(cat /etc/wireguard/hub.pub)"
cat > /etc/wireguard/wg0.conf <<EOF
# Jatelo Connect hub. Router peers are added at runtime by the API and worker.
[Interface]
Address = 10.88.0.1/16
ListenPort = ${WG_PORT}
PrivateKey = $(cat /etc/wireguard/hub.key)
SaveConfig = false
EOF
chmod 600 /etc/wireguard/wg0.conf
systemctl enable wg-quick@wg0 >/dev/null 2>&1
systemctl restart wg-quick@wg0
ok "Hub public key $HUB_PUB"

# Routers must only reach the platform, never each other through the hub.
cat > /etc/systemd/system/jc-wg-isolate.service <<'EOF'
[Unit]
Description=Jatelo Connect: block router-to-router traffic through wg0
After=docker.service wg-quick@wg0.service
Wants=docker.service

[Service]
Type=oneshot
RemainAfterExit=yes
ExecStart=/bin/sh -c 'iptables -C FORWARD -i wg0 -j DROP 2>/dev/null || iptables -I FORWARD 1 -i wg0 -j DROP'
ExecStart=/bin/sh -c 'iptables -C DOCKER-USER -i wg0 -j DROP 2>/dev/null || iptables -I DOCKER-USER 1 -i wg0 -j DROP || true'

[Install]
WantedBy=multi-user.target
EOF
systemctl daemon-reload
systemctl enable --now jc-wg-isolate.service >/dev/null 2>&1
ok "Router-to-router traffic blocked"

# ── 5. Firewall ─────────────────────────────────────────────────────────────
say "Configuring the firewall"
ufw --force reset >/dev/null
ufw default deny incoming >/dev/null
ufw default allow outgoing >/dev/null
ufw allow 22/tcp comment 'SSH' >/dev/null
ufw allow 80/tcp comment 'HTTP (certificates, walled subscribers)' >/dev/null
ufw allow 443/tcp comment 'HTTPS' >/dev/null
ufw allow ${WG_PORT}/udp comment 'WireGuard routers' >/dev/null
ufw allow 1812:1813/udp comment 'RADIUS for non-tunnel devices (registered IPs only)' >/dev/null
ufw allow in on wg0 from 10.88.0.0/16 to any port 8080 proto tcp comment 'Router registration' >/dev/null
ufw allow in on wg0 from 10.88.0.0/16 to any port 1812:1813 proto udp comment 'RADIUS over tunnel' >/dev/null
ufw --force enable >/dev/null
ok "Open: 22, 80, 443, ${WG_PORT}/udp, 1812-1813/udp. API port 8080 reachable only from routers."

# ── 6. Configuration and secrets (kept on re-runs) ──────────────────────────
say "Writing configuration"
hex() { openssl rand -hex "$1"; }
if [ -f .env ]; then
  ok "Keeping existing .env (secrets unchanged)"
  sed -i "s|^WG_HUB_PUBLIC_KEY=.*|WG_HUB_PUBLIC_KEY=${HUB_PUB}|; s|^SERVER_PUBLIC_IP=.*|SERVER_PUBLIC_IP=${PUBLIC_IP}|" .env
else
  cat > .env <<EOF
NODE_ENV=production
APP_DOMAIN=${APP_HOST}
API_DOMAIN=${API_HOST}
PORTAL_DOMAIN=${PORTAL_HOST}
ACME_EMAIL=${ADMIN_EMAIL}

SERVER_PUBLIC_IP=${PUBLIC_IP}
PUBLIC_API_URL=https://${API_HOST}
PORTAL_URL=https://${PORTAL_HOST}
DASHBOARD_URL=https://${APP_HOST}

POSTGRES_PASSWORD=$(hex 24)
APP_DB_PASSWORD=$(hex 24)
RADIUS_DB_PASSWORD=$(hex 24)
JWT_SECRET=$(hex 32)
MASTER_KEY=$(hex 32)
RADIUS_SECRET=$(hex 16)

WG_INTERFACE=wg0
WG_PORT=${WG_PORT}
WG_HUB_PUBLIC_KEY=${HUB_PUB}
WG_MANAGE=true
RADIUS_HOST=10.88.0.1

PORT=8080
TRIAL_DAYS=14
DEFAULT_CURRENCY=BIF
LOG_LEVEL=info
EOF
  chmod 600 .env
  ok "Secrets generated in $APP_DIR/.env (back this file up: it holds the encryption key)"
fi

# ── 7. Start the platform ───────────────────────────────────────────────────
say "Building and starting the platform (first build takes a few minutes)"
docker compose up -d --build --remove-orphans
for i in $(seq 1 60); do
  if curl -fsS http://127.0.0.1:8080/api/health >/dev/null 2>&1; then ok "API healthy"; break; fi
  sleep 3
  [ "$i" -eq 60 ] && { docker compose logs --tail 80 api; die "API did not become healthy"; }
done
sleep 3
docker compose ps --format 'table {{.Service}}\t{{.Status}}'

# ── 8. Jatelo admin account ─────────────────────────────────────────────────
say "Creating the Jatelo admin account"
CRED_FILE=/root/jatelo-admin.txt
if [ ! -f "$CRED_FILE" ]; then
  ADMIN_PASSWORD="$(openssl rand -base64 18 | tr -d '/+=' | cut -c1-16)"
  docker compose exec -T api node src/cli.js create-admin "$ADMIN_EMAIL" "$ADMIN_PASSWORD" "Jatelo Admin" >/dev/null
  printf 'Jatelo Connect admin\nURL: https://%s\nEmail: %s\nPassword: %s\n' "$APP_HOST" "$ADMIN_EMAIL" "$ADMIN_PASSWORD" > "$CRED_FILE"
  chmod 600 "$CRED_FILE"
  ok "Admin created (credentials saved in $CRED_FILE)"
else
  ok "Admin already exists (see $CRED_FILE)"
fi

# ── 9. Nightly database backups (kept 14 days) ──────────────────────────────
say "Scheduling nightly backups"
mkdir -p /var/backups/jatelo
cat > /etc/cron.d/jatelo-backup <<EOF
# Jatelo Connect database backup, 02:30 Bujumbura time
30 2 * * * root cd ${APP_DIR} && docker compose exec -T postgres pg_dump -U jatelo -Fc jatelo > /var/backups/jatelo/jatelo-\$(date +\%F).dump && find /var/backups/jatelo -name '*.dump' -mtime +14 -delete
EOF
ok "Backups in /var/backups/jatelo"

# ── 10. DNS check ───────────────────────────────────────────────────────────
say "Checking DNS"
for h in "$APP_HOST" "$API_HOST" "$PORTAL_HOST"; do
  got="$(getent ahostsv4 "$h" | awk 'NR==1{print $1}' || true)"
  if [ "$got" = "$PUBLIC_IP" ]; then ok "$h → $PUBLIC_IP"; else warn "$h does not point here yet (found: ${got:-nothing}). Add an A record to $PUBLIC_IP; HTTPS starts automatically once it does."; fi
done

cat <<EOF

────────────────────────────────────────────────────────────
 Jatelo Connect is running.

 Dashboard : https://${APP_HOST}
 Portal    : https://${PORTAL_HOST}
 API       : https://${API_HOST}
 Admin     : cat ${CRED_FILE}

 Update later : cd ${APP_DIR} && bash deploy/update.sh
 Logs         : cd ${APP_DIR} && docker compose logs -f api worker radius
────────────────────────────────────────────────────────────
EOF
