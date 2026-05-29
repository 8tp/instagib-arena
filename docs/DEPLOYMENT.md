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

## 3. PaaS (fly.io / Railway / similar)

This is a single **web service** — deploy the image (or let the platform build
from the `Dockerfile`) as one container:

- Bind to the platform's injected `PORT` (the server already reads `PORT`; the
  default is `8787`).
- Attach a **persistent volume mounted at `/app/data`** for the SQLite DB. Most
  PaaS containers have ephemeral filesystems — without a volume, stats reset on
  every redeploy.
- Set `APP_BASE_URL` to your public HTTPS origin (see below).

Platform notes:

- **fly.io** — `fly launch` detects the Dockerfile; create a volume
  (`fly volumes create data`) and mount it at `/app/data` in `fly.toml`. The
  platform terminates TLS and upgrades WebSockets for you.
- **Railway** — deploy from the repo (Dockerfile build); add a volume mounted at
  `/app/data`; Railway provides a public HTTPS domain with WS support.

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

> `DATA_DIR` / `DATABASE_PATH` must resolve to your persistent volume. With the
> Docker image's default `/app/data` volume, the defaults already do.
