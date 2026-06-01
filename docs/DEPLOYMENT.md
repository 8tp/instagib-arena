# Deployment

Instagib Arena ships as **one Node process** that serves the built client, the
stats API, and the `/ws/instagib` game socket on a single port (default
`8787`). There's nothing else to run — no separate API tier, no external
services. Put a TLS terminator / reverse proxy in front and you're live.

For what the process actually does, see the [README](../README.md) and
[ARCHITECTURE](./ARCHITECTURE.md).

---

## 1. Docker

The repo includes a multi-stage [`Dockerfile`](../Dockerfile): a build stage
compiles the client to `dist/`; a lean runtime stage installs production deps
only (`tsx` is a runtime dep — the server runs `tsx server/index.ts`) and copies
in `dist/`, `server/`, and the THREE-free shared modules under `src/game/`.

```bash
docker build -t instagib-arena .
docker run -p 8787:8787 -v "$PWD/data:/app/data" instagib-arena
```

The SQLite stats DB lives at `/app/data` (declared as a `VOLUME` in the image),
so **mount a persistent volume there** or you'll lose all per-browser stats when
the container is replaced. Open <http://localhost:8787>.

To configure, pass env vars with `-e`, e.g.:

```bash
docker run -p 8787:8787 -v "$PWD/data:/app/data" \
  -e APP_BASE_URL=https://arena.example.com \
  instagib-arena
```

---

## 2. Reverse proxy with TLS

Terminate TLS at a reverse proxy and forward to the container/process on
`localhost:8787`. The game uses a WebSocket on the **same origin** as the page
(`/ws/instagib`), so the proxy must let that connection upgrade.

### Caddy (recommended — WS upgrades are automatic)

```caddyfile
arena.example.com {
    reverse_proxy localhost:8787
}
```

Caddy provisions TLS automatically and proxies WebSocket upgrades transparently,
so `/ws/instagib` just works — no extra config.

### nginx

You must explicitly forward the `Upgrade` / `Connection` headers on the WS path
(`location /ws/instagib { proxy_set_header Upgrade $http_upgrade; proxy_set_header Connection "upgrade"; proxy_http_version 1.1; proxy_pass http://localhost:8787; }`),
otherwise the game socket fails to connect.

When fronting the app with a real domain, set `APP_BASE_URL` (see below) to that
HTTPS origin so the WebSocket origin allow-list accepts your browser clients.

---

## 3. Railway (recommended PaaS)

Instagib Arena is an ideal fit for Railway: one always-on container with
WebSockets, a persistent volume, and a free HTTPS domain. The repo ships a
[`railway.json`](../railway.json) that builds from the `Dockerfile` and
health-checks `/api/health`.

**One-time setup**

1. **Create the project** — Railway → _New Project → Deploy from GitHub_ (or
   `railway init` then `railway up`). It auto-detects the `Dockerfile` +
   `railway.json`.
2. **Add a Volume mounted at `/app/data`** (service → _Volumes_). The SQLite
   stats DB lives there; without it, stats reset on every redeploy.
3. **Pick the region closest to your players** (service → _Settings → Region_).
   It's an FPS — round-trip latency is the whole game, and you're single-region
   by design.
4. **Generate a domain** (_Settings → Networking → Generate Domain_) and set
   `APP_BASE_URL` to that `https://…up.railway.app` origin (_Variables_) — it's
   the WebSocket origin allow-list.
5. **Claim your admin account** — set `ADMIN_USERNAMES` (_Variables_) to your
   handle(s), then register that username in-game. It's auto-promoted on
   registration (and any matching existing account is promoted on the next
   boot), unlocking the staff badge, all cosmetics, and the verify-players panel.

> **Critical: run exactly ONE instance.** The game server holds all room/match
> state in memory and stats in local SQLite, so it must not be horizontally
> scaled. Keep replicas at **1** (the default; `railway.json` also pins
> `numReplicas: 1`). Two+ instances would split players across isolated,
> non-communicating servers and fork the SQLite file.

**Notes**

- Railway injects `PORT`; the server already binds to it — no port config needed.
- WebSockets + TLS are handled at Railway's edge, so `/ws/instagib` works on the
  generated domain with no extra setup.
- Use a plan where the service **does not sleep** — a sleeping multiplayer server
  means dead lobbies (idle-sleep is a hobby-tier behavior).
- Healthcheck is `/api/health` (already set in `railway.json`).
- Cost: a small always-on container is a few dollars/month on usage pricing.

### Other PaaS (fly.io, Render, …)

Same single-service shape: build the `Dockerfile`, bind the injected `PORT`,
mount a volume at `/app/data`, set `APP_BASE_URL`, and keep it to **one
instance**. On **fly.io**: `fly launch` detects the Dockerfile, `fly volumes
create data`, mount it at `/app/data` in `fly.toml`; TLS + WS upgrades are
automatic.

---

## 4. Environment variables

All are optional; see [`.env.example`](../.env.example) for the canonical list.
In containers/PaaS, set them in the platform's env config rather than a `.env`
file.

| Variable        | Default                    | Purpose                                                                                          |
| --------------- | -------------------------- | ------------------------------------------------------------------------------------------------ |
| `PORT`          | `8787`                     | Port the Node server listens on (set this to the PaaS-injected port).                            |
| `HOST`          | `0.0.0.0` (prod)           | Bind address.                                                                                     |
| `DATA_DIR`      | `./data`                   | Directory for runtime data (the SQLite DB). Point this at your mounted volume if not `/app/data`.|
| `DATABASE_PATH` | `./data/instagib.sqlite`   | Explicit DB file path (overrides `DATA_DIR`).                                                     |
| `APP_BASE_URL`  | _(unset)_                  | Production WebSocket origin allow-list — your public HTTPS origin. Unset = same-origin only.     |
| `ADMIN_USERNAMES` | _(unset)_                | Comma/space-separated admin usernames (case-insensitive). Promoted on boot + at registration.   |

> `DATA_DIR` / `DATABASE_PATH` must resolve to your persistent volume. With the
> Docker image's default `/app/data` volume, the defaults already do.
