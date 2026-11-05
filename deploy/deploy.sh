#!/usr/bin/env bash
# One-command deploy for Tharam Store Guard on Ubuntu.
# First run:   curl -fsSL https://raw.githubusercontent.com/swattoolchain/smart/main/deploy/deploy.sh | sudo bash
# Updates:     sudo bash /opt/tharam/deploy/deploy.sh
#
# Two modes, picked automatically:
#  - shared: another Caddy container already owns ports 80/443 (e.g. Specialley). Store Guard runs as its
#            own compose project on that Caddy's network, and a site block is added to that Caddyfile.
#  - standalone: nothing on 80/443. Store Guard brings its own Caddy.
set -euo pipefail

REPO="https://github.com/swattoolchain/smart.git"
DIR="/opt/tharam"
DOMAIN="${DOMAIN:-tharam.store}"
EXISTING_CADDY="${EXISTING_CADDY:-specialley-caddy-1}"
EXISTING_CADDYFILE="${EXISTING_CADDYFILE:-/opt/specialley/deploy/Caddyfile}"

say() { printf '\n\033[1m%s\033[0m\n' "$*"; }
if [ "$(id -u)" -ne 0 ]; then echo "Run with sudo"; exit 1; fi

if ! command -v docker >/dev/null 2>&1; then say "Installing Docker"; curl -fsSL https://get.docker.com | sh; fi
if ! command -v git >/dev/null 2>&1; then apt-get update && apt-get install -y git; fi

if [ -d "$DIR/.git" ]; then say "Updating code"; git -C "$DIR" pull --ff-only
else say "Downloading code"; git clone "$REPO" "$DIR"; fi
cd "$DIR/deploy"

if [ ! -f .env ]; then
  say "First-time setup"
  read -rp "Your email (gets signup and lead notifications, unlocks the founder view): " ADMIN_EMAIL </dev/tty
  read -rp "Cal.com booking link for demos, e.g. cal.com/yourname/demo (leave empty to set later): " CAL_LINK </dev/tty
  read -rp "Anthropic API key for AI review (sk-ant-...), leave empty to skip: " AI_API_KEY </dev/tty
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
CONTACT_EMAIL=hello@$DOMAIN
CAL_LINK=$CAL_LINK
AI_API_KEY=$AI_API_KEY
AI_PROVIDER=anthropic
RUN_CONCURRENCY=2
JOURNEY_INTERVAL_MIN=180
FULL_SCAN_INTERVAL_MIN=1440
FREE_SCANS_PER_IP_PER_HOUR=3
EOF
  chmod 600 .env
  echo "Saved settings to $DIR/deploy/.env (edit any time, then re-run this script)."
fi

if docker ps --format '{{.Names}}' | grep -qx "$EXISTING_CADDY"; then
  MODE=shared
  EDGE_NETWORK=$(docker inspect "$EXISTING_CADDY" -f '{{range $k, $v := .NetworkSettings.Networks}}{{$k}} {{end}}' | awk '{print $1}')
  say "Found existing Caddy ($EXISTING_CADDY) on network '$EDGE_NETWORK': deploying behind it"
  export EDGE_NETWORK
  docker compose -f docker-compose.shared.yml up -d --build

  if ! grep -q "^$DOMAIN {" "$EXISTING_CADDYFILE"; then
    say "Adding $DOMAIN to $EXISTING_CADDYFILE"
    cp "$EXISTING_CADDYFILE" "$EXISTING_CADDYFILE.bak-$(date +%Y%m%d%H%M%S)"
    # Append (keeps the same file inode, so the bind mount inside the container sees the change).
    cat >> "$EXISTING_CADDYFILE" <<EOF

# --- Tharam Store Guard (added by /opt/tharam/deploy/deploy.sh) ---
www.$DOMAIN {
	redir https://$DOMAIN{uri} permanent
}

$DOMAIN {
	encode zstd gzip
	header -Server
	reverse_proxy tharam-guard:3000
}
EOF
  fi
  CONF=$(docker inspect "$EXISTING_CADDY" -f '{{range .Mounts}}{{if eq .Source "'"$EXISTING_CADDYFILE"'"}}{{.Destination}}{{end}}{{end}}')
  CONF="${CONF:-/etc/caddy/Caddyfile}"
  if docker exec "$EXISTING_CADDY" caddy validate --config "$CONF" --adapter caddyfile >/dev/null 2>&1; then
    docker exec "$EXISTING_CADDY" caddy reload --config "$CONF" --adapter caddyfile
    echo "Caddy reloaded with $DOMAIN."
  else
    echo "Caddy config did not validate. Restoring the backup; your other sites are untouched."
    LATEST=$(ls -t "$EXISTING_CADDYFILE".bak-* | head -1); cat "$LATEST" > "$EXISTING_CADDYFILE"
    docker exec "$EXISTING_CADDY" caddy validate --config "$CONF" --adapter caddyfile
    exit 1
  fi
  COMPOSE="docker compose -f docker-compose.shared.yml"
else
  MODE=standalone
  say "No existing Caddy found: deploying with bundled Caddy on ports 80/443"
  docker compose up -d --build
  COMPOSE="docker compose"
fi

say "Waiting for the app"
HEALTHY=0
for i in $(seq 1 60); do
  if $COMPOSE exec -T guard node -e "fetch('http://localhost:3000/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))" 2>/dev/null; then
    echo "App is healthy."; HEALTHY=1; break
  fi
  sleep 3
done

# Free disk only after a successful deploy, so a failed one keeps everything for a quick look or rollback.
if [ "$HEALTHY" = "1" ]; then
  say "Cleaning up old Docker images and build cache"
  bash "$DIR/deploy/docker-cleanup.sh" || true
else
  echo "The app did not answer yet, so old Docker images were kept. Check: cd $DIR/deploy && $COMPOSE logs guard"
fi

IP=$(curl -fsS https://api.ipify.org 2>/dev/null || hostname -I | awk '{print $1}')
say "Done ($MODE mode)"
echo "1. DNS: A records for $DOMAIN and www.$DOMAIN -> $IP"
echo "2. Open https://$DOMAIN (certificate is issued automatically once DNS resolves)"
echo "3. Sign up at https://$DOMAIN/app with $(grep ^ADMIN_EMAIL .env | cut -d= -f2) to see the founder view"
echo "Logs:    cd $DIR/deploy && $COMPOSE logs -f guard"
echo "Verify:  cd $DIR/deploy && $COMPOSE exec guard node src/verify.js"
