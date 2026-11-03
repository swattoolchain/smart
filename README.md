# Tharam

Monorepo for Tharam's e-commerce reliability products.

| Path | Product | Status |
|---|---|---|
| `apps/guard` | **Store Guard**: functional, regression and non-functional monitoring for Shopify stores, plus the tharam.store website | Live beta |
| `deploy` | Docker Compose, Caddy (automatic HTTPS) and the one-command VM deploy script | |

New plugins go under `apps/<name>`, each with its own `package.json` and `Dockerfile`, and get added as a service in `deploy/docker-compose.yml`.

## Deploy to a VM

On a fresh Ubuntu 22.04/24.04 server (2 GB RAM minimum, 4 GB recommended), with ports 80 and 443 open:

```bash
curl -fsSL https://raw.githubusercontent.com/swattoolchain/smart/main/deploy/deploy.sh | sudo bash
```

Then point the `tharam.store` and `www.tharam.store` A records at the server's IP. HTTPS certificates are issued automatically.

The script picks a mode automatically:
- **Shared:** if a Caddy container named `specialley-caddy-1` already owns ports 80/443, Store Guard runs as its own compose project (`tharam`) on that Caddy's Docker network, and a `tharam.store` site block is appended to `/opt/specialley/deploy/Caddyfile` (backed up first, validated, then reloaded; restored if validation fails). Override with `EXISTING_CADDY=` and `EXISTING_CADDYFILE=`.
- **Standalone:** otherwise it brings its own Caddy (`deploy/docker-compose.yml`).

Update to the latest code at any time:

```bash
sudo bash /opt/tharam/deploy/deploy.sh
```

Settings live in `/opt/tharam/deploy/.env` (SMTP, admin email, check intervals). Edit and re-run the deploy script to apply.

Back up the data volume (database, screenshots, visual baselines):

```bash
cd /opt/tharam/deploy && docker compose -f docker-compose.shared.yml exec guard sh -c 'tar czf - /data' > tharam-backup-$(date +%F).tgz
```
