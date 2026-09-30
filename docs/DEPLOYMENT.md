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
only (`tsx` is a runtime dep — the server runs `node --import tsx server/index.ts`) and copies
in `dist/`, `server/`, and the THREE-free shared modules under `src/game/`.

```bash
docker build -t instagib-arena .
docker run -p 8787:8787 -v "$PWD/data:/app/data" instagib-arena
```

The image uses Node 24 LTS on Debian 13, removes npm/Yarn from the runtime, and
drops to the `node` user before serving. Its entrypoint fixes data-volume
ownership so existing volumes from the former root process remain usable.

The SQLite stats DB lives at `/app/data`, so **mount a persistent volume there**
or you'll lose all stats/accounts when the container is replaced. Open
<http://localhost:8787>.

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
5. **Create your admin account** — register your own account first, then set
   `ADMIN_USERNAMES` (_Variables_) to that existing handle and redeploy. Public
   registration cannot claim a configured admin name. Promotion happens on boot.

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
| `APP_BASE_URL`  | _(unset)_                  | Exact public origin for browser writes and WebSockets. When set, other origins are rejected. |
| `TRUST_PROXY_HOPS` | `1` on Railway, `0` elsewhere | Trusted ingress count; XFF proxies count from the right. The backend must be reachable only through those proxies. |
| `TRUST_PROXY_HEADER` | `x-real-ip` on Railway, `x-forwarded-for` elsewhere | Railway overwrites the visitor IP in `X-Real-IP`; other proxies use the configured XFF chain. |
| `ADMIN_USERNAMES` | _(unset)_                | Comma/space-separated admin usernames (case-insensitive). Existing accounts promoted on boot; configured names cannot register.   |

> `DATA_DIR` / `DATABASE_PATH` must resolve to your persistent volume. With the
> Docker image's default `/app/data` volume, the defaults already do.

## Proxy identity and security checks

Railway overrides a Docker image's entrypoint when a start command is configured.
The command in `railway.json` explicitly invokes `instagib-entrypoint` so existing
volume ownership is prepared and the game process runs as the unprivileged Node user.

For Cloudflare → Railway → game server, Railway is the one trusted immediate
proxy. A production check on 2026-09-29 verified that Railway overwrites
`X-Real-IP` to the visitor's address on both `instagib.win` and the public
Railway URL, even when the caller supplies another value. This is the shared
identity source for HTTP, WebSockets and game rewards. Railway's XFF chain also
contains another edge address, so selecting its rightmost value gives the wrong
identity. `CF-Connecting-IP` is ignored because direct Railway callers can forge
it. See [Railway's request headers](https://docs.railway.com/networking/public-networking/specs-and-limits).

Outside Railway, configure only append-only proxy hops that cannot be bypassed;
the default trusts no proxy. Do not increase `TRUST_PROXY_HOPS` to expose
client-supplied headers.

The cookie session expires after 30 days on the server, and session tokens are
stored as SHA-256 hashes. Existing sessions older than that require a new login.
Metrics bearer tokens authorize only reads under `/api/admin/metrics/`.

Run `npm run test:security`, `npm run typecheck`, `npm run lint`,
`npm run build`, and `npm audit` before shipping. CI runs these checks and CodeQL
analyzes JavaScript/TypeScript on every push/PR and weekly. GitHub dependency
alerts, security updates, secret scanning and push protection must remain enabled.
