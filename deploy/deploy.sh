#!/usr/bin/env bash
# One-command deploy for Tharam Store Guard on Ubuntu 22.04/24.04.
# First run:   curl -fsSL https://raw.githubusercontent.com/swattoolchain/smart/main/deploy/deploy.sh | sudo bash
# Updates:     sudo bash /opt/tharam/deploy/deploy.sh
set -euo pipefail

REPO="https://github.com/swattoolchain/smart.git"
DIR="/opt/tharam"
DOMAIN="${DOMAIN:-tharam.store}"

say() { printf '\n\033[1m%s\033[0m\n' "$*"; }

if [ "$(id -u)" -ne 0 ]; then echo "Run with sudo"; exit 1; fi

if ! command -v docker >/dev/null 2>&1; then
  say "Installing Docker"
  curl -fsSL https://get.docker.com | sh
fi
if ! command -v git >/dev/null 2>&1; then apt-get update && apt-get install -y git; fi

if [ -d "$DIR/.git" ]; then
  say "Updating code"
  git -C "$DIR" pull --ff-only
else
  say "Downloading code"
  git clone "$REPO" "$DIR"
fi

cd "$DIR/deploy"
if [ ! -f .env ]; then
  say "First-time setup"
  read -rp "Your email (gets signup and lead notifications, unlocks the founder view): " ADMIN_EMAIL </dev/tty
  read -rp "SMTP host for alert emails (leave empty to set up later): " SMTP_HOST </dev/tty
  SMTP_PORT=587; SMTP_USER=""; SMTP_PASS=""
  if [ -n "$SMTP_HOST" ]; then
    read -rp "SMTP port [587]: " p </dev/tty; SMTP_PORT="${p:-587}"
    read -rp "SMTP username: " SMTP_USER </dev/tty
    read -rsp "SMTP password: " SMTP_PASS </dev/tty; echo
  fi
  cat > .env <<EOF
DOMAIN=$DOMAIN
BASE_URL=https://$DOMAIN
SESSION_SECRET=$(openssl rand -hex 32)
ADMIN_EMAIL=$ADMIN_EMAIL
SMTP_HOST=$SMTP_HOST
SMTP_PORT=$SMTP_PORT
SMTP_USER=$SMTP_USER
SMTP_PASS=$SMTP_PASS
MAIL_FROM=Tharam Store Guard <alerts@$DOMAIN>
RUN_CONCURRENCY=2
JOURNEY_INTERVAL_MIN=180
FULL_SCAN_INTERVAL_MIN=1440
FREE_SCANS_PER_IP_PER_HOUR=3
EOF
  chmod 600 .env
  echo "Saved settings to $DIR/deploy/.env (edit any time, then re-run this script)."
fi

say "Building and starting (first build takes a few minutes)"
docker compose up -d --build

say "Waiting for the app"
for i in $(seq 1 40); do
  if docker compose exec -T guard node -e "fetch('http://localhost:3000/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))" 2>/dev/null; then
    echo "App is healthy."; break
  fi
  sleep 3
done

IP=$(curl -fsS https://api.ipify.org 2>/dev/null || hostname -I | awk '{print $1}')
say "Done"
echo "Server IP: $IP"
echo "1. Point DNS A records for $DOMAIN and www.$DOMAIN to $IP"
echo "2. Open https://$DOMAIN (HTTPS is issued automatically once DNS resolves; allow ports 80 and 443 in your firewall)"
echo "3. Sign up at https://$DOMAIN/app with $( grep ^ADMIN_EMAIL .env | cut -d= -f2 ) to see the founder view"
echo "Logs: cd $DIR/deploy && docker compose logs -f guard"
echo "Verify on real stores: cd $DIR/deploy && docker compose exec guard node src/verify.js"
