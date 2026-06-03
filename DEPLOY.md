# Deployment — Oracle Cloud Free Tier (Ubuntu, ARM / Ampere A1)

This app is a long-running Node server (Next.js standalone). Two supported
paths: **Docker Compose (recommended)** or **bare Node + PM2**. Everything
works on `arm64` — all dependencies are pure-JS or ship arm64 prebuilds.

> Sizing: a Next build needs ~1.5–2 GB RAM. The Ampere A1 always-free shape
> (up to 4 OCPU / 24 GB) is plenty. On a 1 GB shape, add swap (see bottom).

---

## 0. Open the ports (Oracle's #1 gotcha)

Two layers block traffic by default — you must open **both**:

1. **VCN Security List / NSG** (in the Oracle console): add ingress rules for
   TCP **80** and **443** from `0.0.0.0/0`.
2. **The instance firewall.** Ubuntu images on Oracle ship locked-down
   `iptables`. Open and persist 80/443:

```bash
sudo iptables -I INPUT 6 -m state --state NEW -p tcp --dport 80 -j ACCEPT
sudo iptables -I INPUT 6 -m state --state NEW -p tcp --dport 443 -j ACCEPT
sudo netfilter-persistent save
```

---

## Option A — Docker Compose (recommended)

### 1. Install Docker

```bash
curl -fsSL https://get.docker.com | sh
sudo usermod -aG docker $USER && newgrp docker
```

### 2. Get the code + secrets

```bash
git clone <your-repo> app && cd app
cp .env.example .env && nano .env      # add API keys (all optional)
```

### 3. Build + run (app only — your existing nginx fronts it)

```bash
docker compose up -d --build
docker compose logs -f web      # watch startup
```

The container binds to `127.0.0.1:3500` (not public), so it's reachable only
through nginx.

### 4. Wire up nginx

A ready config is in `deploy/nginx/fundamental.conf` (server name
`fundamental.darabi.website`, proxying to `127.0.0.1:3500`). Install it:

```bash
sudo cp deploy/nginx/fundamental.conf /etc/nginx/sites-available/fundamental.darabi.website
sudo ln -s /etc/nginx/sites-available/fundamental.darabi.website /etc/nginx/sites-enabled/
sudo nginx -t && sudo systemctl reload nginx
```

Visit `https://fundamental.darabi.website`. Update later with:

```bash
git pull && docker compose up -d --build
```

The image runs as an unprivileged user, restarts on crash/reboot, and has a
healthcheck on `/api/macro`.

---

## Option B — Bare Node + PM2 (behind your nginx)

### 1. Node 22 (via nvm) + build

```bash
curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.1/install.sh | bash
. ~/.nvm/nvm.sh && nvm install 22
git clone <your-repo> app && cd app
cp .env.example .env && nano .env
npm ci
npm run build
```

### 2. Keep it alive with PM2

```bash
npm i -g pm2
# Run the standalone server on 3500 (to match the nginx config).
PORT=3500 pm2 start "node .next/standalone/server.js" \
  --name fundamental-dashboard --update-env
pm2 save && pm2 startup     # run the printed command to enable on boot
```

> The standalone server needs `public/` and `.next/static/` beside it — they're
> already in the repo root, so start it from there. It reads `.env` from the
> working directory.

### 3. nginx

Same config as the Docker path — `deploy/nginx/fundamental.conf` proxies to
`127.0.0.1:3500`:

```bash
sudo cp deploy/nginx/fundamental.conf /etc/nginx/sites-available/fundamental.darabi.website
sudo ln -s /etc/nginx/sites-available/fundamental.darabi.website /etc/nginx/sites-enabled/
sudo nginx -t && sudo systemctl reload nginx
```

---

## Environment notes

- All provider/AI keys are **optional** — absent ones fall back to fixtures.
- Caching uses in-memory LRU by default (fine for a single instance). Set
  `UPSTASH_REDIS_REST_URL` / `_TOKEN` only if you run multiple instances.
- For a fast offline demo, set `USE_FIXTURES=1` in `.env`.
- Verify keys after deploy: `npm run check:apis` (never prints secrets).

## Low-memory build (1 GB shapes) — add swap

```bash
sudo fallocate -l 2G /swapfile && sudo chmod 600 /swapfile
sudo mkswap /swapfile && sudo swapon /swapfile
echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab
```
