#!/usr/bin/env bash
# Turns a fresh Ubuntu VM into a Tharam worker: a machine that runs checks for the main server.
#
# 1. In the founder console → Runners → "Add a worker", create a join token (name, slots, tags).
# 2. On the new VM:
#      curl -fsSL https://raw.githubusercontent.com/swattoolchain/smart/main/deploy/worker.sh | sudo bash
#    It asks for the main server address and the join token. To skip the questions:
#      curl -fsSL …/worker.sh | sudo MAIN_URL=https://tharam.store JOIN_TOKEN=tjr_… bash
# 3. The worker appears in Runners as "Checking in" within a minute.
#
# Updates (new code): sudo bash /opt/tharam-worker/deploy/worker.sh  (no questions; keeps its credentials).
# This script only sets up this machine; it never connects to the main server itself except through the worker.
set -euo pipefail

REPO="${REPO:-https://github.com/swattoolchain/smart.git}"
DIR="${DIR:-/opt/tharam-worker}"
PROJECT="tharam-worker"
# For tests: only write the settings file and print what would run (no root, no Docker, no git).
DRY_RUN="${WORKER_SETUP_DRY_RUN:-0}"

say() { printf '\n\033[1m%s\033[0m\n' "$*"; }
fail() { printf '\n\033[1;31m%s\033[0m\n' "$*" >&2; exit 1; }
run() { if [ "$DRY_RUN" = "1" ]; then echo "would run: $*"; else "$@"; fi; }

valid_url() { [[ "$1" =~ ^https://[A-Za-z0-9.-]+(:[0-9]+)?/?$ ]]; }
valid_token() { [[ "$1" =~ ^tjr_[A-Za-z0-9_-]{20,}$ ]]; }
ask() { # ask VAR "question" [default]
  local v="${!1:-}"
  if [ -z "$v" ] && [ -r /dev/tty ] && [ "$DRY_RUN" != "1" ]; then read -rp "$2${3:+ [$3]}: " v </dev/tty; fi
  printf -v "$1" '%s' "${v:-${3:-}}"
}

if [ "$DRY_RUN" != "1" ]; then
  if [ "$(id -u)" -ne 0 ]; then fail "Run with sudo"; fi
  if ! command -v docker >/dev/null 2>&1; then say "Installing Docker"; curl -fsSL https://get.docker.com | sh; fi
  if ! command -v git >/dev/null 2>&1; then apt-get update && apt-get install -y git; fi
  if [ -d "$DIR/.git" ]; then say "Updating code"; git -C "$DIR" pull --ff-only
  else say "Downloading code"; git clone "$REPO" "$DIR"; fi
fi
mkdir -p "$DIR/deploy"
cd "$DIR/deploy"

if [ ! -f worker.env ]; then
  say "First-time setup"
  ask MAIN_URL "Main server address" "https://tharam.store"
  MAIN_URL="${MAIN_URL%/}"
  valid_url "$MAIN_URL" || fail "The main server address must start with https:// (store passwords travel with each check). Got: $MAIN_URL"
  ask JOIN_TOKEN "Join token from the founder console (Runners → Add a worker)"
  valid_token "${JOIN_TOKEN:-}" || fail "That doesn't look like a join token (it starts with tjr_). Create one in the founder console → Runners → Add a worker."
  umask 077
  cat > worker.env <<EOF
MAIN_URL=$MAIN_URL
JOIN_TOKEN=$JOIN_TOKEN
WORKER_POLL_MS=2000
EOF
  chmod 600 worker.env
  echo "Saved settings to $DIR/deploy/worker.env."
else
  say "Using the saved settings in $DIR/deploy/worker.env"
fi

COMPOSE="docker compose -p $PROJECT -f docker-compose.worker.yml"
say "Building and starting the worker"
run $COMPOSE up -d --build

if [ "$DRY_RUN" = "1" ]; then echo "would wait for the worker to join, then remove JOIN_TOKEN from worker.env"; exit 0; fi

say "Waiting for the worker to join"
joined=0
for i in $(seq 1 40); do
  if $COMPOSE exec -T worker test -f /data/runner.json 2>/dev/null; then joined=1; break; fi
  case "$($COMPOSE ps -a --format '{{.State}}' worker 2>/dev/null)" in exited|restarting) [ "$i" -gt 3 ] && break ;; esac
  sleep 3
done
if [ "$joined" != "1" ]; then
  $COMPOSE logs --tail 20 worker || true
  $COMPOSE down || true
  rm -f worker.env
  fail "The worker could not join (see the log above). Join tokens work once and for 24 hours: create a new one in Runners and run this script again."
fi
# The token has done its job: the worker now has its own credentials in its data volume.
sed -i '/^JOIN_TOKEN=/d' worker.env

say "Checking that it talks to the main server"
healthy=0
for i in $(seq 1 20); do
  if $COMPOSE exec -T worker node -e "const h=JSON.parse(require('fs').readFileSync('/data/worker-health.json','utf8'));process.exit(Date.now()-Date.parse(h.at)<60000?0:1)" 2>/dev/null; then healthy=1; break; fi
  sleep 3
done
NAME=$($COMPOSE exec -T worker node -e "console.log(JSON.parse(require('fs').readFileSync('/data/runner.json','utf8')).name)" 2>/dev/null || echo "this worker")
if [ "$healthy" = "1" ]; then say "Done: \"$NAME\" is checking in"; else say "\"$NAME\" joined but has not checked in yet; see the logs below"; fi
echo "It shows in the founder console → Runners. Drain it there before switching this machine off."
echo "Logs:    cd $DIR/deploy && $COMPOSE logs -f worker"
echo "Update:  sudo bash $DIR/deploy/worker.sh"
echo "Remove:  drain it in Runners, then: cd $DIR/deploy && $COMPOSE down"
